// ==UserScript==
// @name        Forum Stumbler
// @namespace   https://github.com/VitaKaninen
// @version     0.6.0
// @author      VitaKaninen
// @description Capture every topic link on a forum index page, then walk them with Back/Next buttons — no tabs. Opt-in per site, with teachable per-site link patterns.
// @match       *://*/*
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_deleteValue
// @grant       GM_registerMenuCommand
// @grant       GM_xmlhttpRequest
// @connect     self
// @run-at      document-idle
// @downloadURL  https://raw.githubusercontent.com/VitaKaninen/Forum-Stumbler/main/Forum-Stumbler.user.js
// @updateURL    https://raw.githubusercontent.com/VitaKaninen/Forum-Stumbler/main/Forum-Stumbler.user.js
// ==/UserScript==

(function () {
    'use strict';
    if (window !== window.top) return; // top frame only

    // ---------------- Config ----------------
    const TOUR_KEY = 'fs_tour';           // { urls, titles, source, sourceTitle, nextPage, ts }
    const POS_KEY = 'fs_barpos';          // { right, bottom }
    const RESUME_KEY = 'fs_resume';       // '' | 'append' — set when we navigate to a next page as a fallback
    const SITES_KEY = 'fs_sites';         // { "<domain>": { pattern: string|null, sig: string|null } }
    const AUTO_CHAIN = true;              // pull the forum's "next page" of results at end of a tour
    const MIN_CLUSTER = 4;                // heuristic: need at least this many links to call it a topic list
    const MIN_TAUGHT = 2;                 // taught pattern/signature: trust smaller lists
    const MIN_TITLE_LEN = 12;             // topic titles tend to be wordy

    // Known forum topic-URL patterns (a match makes a cluster near-certain).
    const TOPIC_PATTERNS = [
        /\/t\/[^/]+\/\d+/i,        // Discourse
        /\/threads\//i,             // XenForo / vBulletin 4+
        /showthread\.php/i,         // vBulletin
        /viewtopic\.php/i,          // phpBB
        /[?&]topic=\d/i,            // SMF
        /\/topic\/\d/i,             // Invision (IPB)
        /\/comments\//i,            // Reddit
        /\/post\/\d/i,              // Lemmy
        /item\?id=\d/i,             // Hacker News
        /\/discussion\//i,          // Vanilla
        /\/thread[s]?[-/]/i         // generic
    ];

    // Hrefs that are clearly NOT topics (nav/pagination/account/etc). Heuristic only —
    // a taught pattern overrides this list.
    const NEGATIVE = /(\/login|\/logout|\/register|\/signup|\/sign-in|\/profile|\/members?\/|\/users?\/|\/tag[s]?\/|\/categor|\/forum[s]?\/?$|[?&]page=|\/page\/\d|[?&]start=\d|\/search|\/rss|\/feed|\.(png|jpe?g|gif|svg|css|js|pdf|zip)(\?|$))/i;

    // ---------------- Utilities ----------------
    // Normalise a URL for comparison/storage: absolute, no hash, no trailing slash.
    const norm = (u, base) => {
        try {
            const x = new URL(u, base || location.href);
            x.hash = '';
            return x.href.replace(/\/$/, '');
        } catch (_) { return u; }
    };

    const loadTour = () => {
        try { return JSON.parse(GM_getValue(TOUR_KEY, 'null')); } catch (_) { return null; }
    };
    const saveTour = (t) => GM_setValue(TOUR_KEY, JSON.stringify(t));
    const go = (url) => { location.href = url; };

    function inChrome(el) {
        // true if inside site chrome (nav/header/footer/aside) — not main content
        return !!el.closest('nav,header,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"]');
    }

    function inPagination(el) {
        // In-topic pagination ("Go to page: 1, 2") and paging arrow containers.
        return !!el.closest('.pagination, .pager, .pages, [class*="pagination"], [class*="pager"]');
    }

    function signature(a, useClasses) {
        // Structural fingerprint of an anchor: tag (+classes) chain of up to 4 ancestors.
        let parts = [];
        let el = a;
        for (let i = 0; i < 4 && el && el.tagName; i++) {
            let sig = el.tagName.toLowerCase();
            if (useClasses) {
                const cls = (el.getAttribute('class') || '')
                    .trim().split(/\s+/).slice(0, 2)
                    .map(c => c.replace(/\d+/g, '#')).join('.');
                if (cls) sig += '.' + cls;
            }
            parts.push(sig);
            el = el.parentElement;
        }
        return parts.join('>');
    }

    // ---------------- Site list (opt-in) ----------------
    function getSites() {
        try {
            const o = JSON.parse(GM_getValue(SITES_KEY, 'null'));
            return (o && typeof o === 'object') ? o : {};
        } catch (_) { return {}; }
    }
    const saveSites = (s) => GM_setValue(SITES_KEY, JSON.stringify(s));

    const normDomain = (raw) => (raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];

    function getSiteFor(hostname) {
        const sites = getSites();
        const h = (hostname || '').toLowerCase();
        for (const d of Object.keys(sites)) {
            if (h === d || h.endsWith('.' + d)) return { domain: d, cfg: sites[d] || {} };
        }
        return null;
    }

    // ---------------- Detection ----------------
    // Works on either the live document or a fetched-and-parsed one; `base` is that
    // document's own URL so relative hrefs resolve correctly.

    // Shared anchor filter: same-site, not the current page, not pagination, has a
    // title-ish text. `applyNegative` is skipped for taught patterns (the pattern is
    // the authority there).
    function collectAnchors(root, base, applyNegative) {
        let baseOrigin;
        try { baseOrigin = new URL(base).origin; } catch (_) { return null; }
        const here = norm(base, base);
        const records = [];
        for (const a of root.querySelectorAll('a[href]')) {
            const raw = a.getAttribute('href');
            if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel):/i.test(raw)) continue;
            let url;
            try { url = new URL(raw, base); } catch (_) { continue; }
            if (url.origin !== baseOrigin) continue;              // same-site topics only
            const nurl = norm(url.href, base);
            if (nurl === here) continue;                          // not the current page
            if (applyNegative && NEGATIVE.test(nurl)) continue;
            if (inChrome(a)) continue;
            if (inPagination(a)) continue;
            const text = (a.textContent || '').trim();
            if (text.length < 2) continue;            // single chars: » « ‹ › etc.
            if (/^\d{1,5}$/.test(text)) continue;     // bare page numbers: 1, 2, 3…
            records.push({ a, url: nurl, urlObj: url, text });
        }
        return records;
    }

    // Taught pattern: match pathname+search of every anchor against the stored regex.
    // Survives fetched raw HTML (no live-DOM structure needed) and theme changes.
    function detectByPattern(root, base, patternSrc) {
        let rx;
        try { rx = new RegExp(patternSrc, 'i'); } catch (_) { return null; }
        base = base || location.href;
        const records = collectAnchors(root, base, false);
        if (!records) return null;
        const byUrl = new Map();
        for (const r of records) {
            if (!rx.test(r.urlObj.pathname + r.urlObj.search)) continue;
            const prev = byUrl.get(r.url);
            if (!prev) byUrl.set(r.url, { url: r.url, text: r.text });
            else if (r.text.length > prev.text.length) prev.text = r.text; // keep the wordiest (title beats "5 replies")
        }
        const list = Array.from(byUrl.values());
        return list.length ? list : null;
    }

    // Heuristic clustering (bootstrap for un-taught sites). Pass `onlySig` to restrict
    // to a taught structural signature instead of free scoring.
    function detectTopics(root, base, onlySig) {
        base = base || location.href;
        const records = collectAnchors(root, base, true);
        if (!records) return null;

        if (onlySig) {
            const seen = new Set();
            const uniq = [];
            for (const r of records) {
                if (signature(r.a, true) !== onlySig) continue;
                if (seen.has(r.url)) continue;
                seen.add(r.url);
                uniq.push({ url: r.url, text: r.text });
            }
            return uniq.length >= MIN_TAUGHT ? uniq : null;
        }

        const bestCluster = (useClasses) => {
            const groups = new Map();
            for (const r of records) {
                const sig = signature(r.a, useClasses);
                if (!groups.has(sig)) groups.set(sig, []);
                groups.get(sig).push(r);
            }
            let best = null, bestScore = 0;
            for (const [, items] of groups) {
                // dedupe by url, keep first (usually the title link)
                const seen = new Set();
                const uniq = items.filter(it => !seen.has(it.url) && seen.add(it.url));
                if (uniq.length < MIN_CLUSTER) continue;

                const patternHits = uniq.filter(it => TOPIC_PATTERNS.some(p => p.test(it.url))).length;
                const wordy = uniq.filter(it => it.text.length >= MIN_TITLE_LEN).length;

                // score: size + wordiness + heavy bonus for known patterns
                let score = uniq.length + wordy * 0.5 + (patternHits / uniq.length) * uniq.length * 2;
                if (score > bestScore) { bestScore = score; best = uniq; }
            }
            return best ? best.map(it => ({ url: it.url, text: it.text })) : null;
        };

        // Class-based signatures first. Per-row class variation (sticky/unread/locked,
        // CSS-module hashes) can splinter the real list below MIN_CLUSTER — retry with
        // tag-only signatures before giving up.
        return bestCluster(true) || bestCluster(false);
    }

    // Detection order for an opted-in site: taught URL pattern → taught structural
    // signature → generic heuristic.
    function detectForSite(root, base, cfg) {
        if (cfg && cfg.pattern) {
            const r = detectByPattern(root, base, cfg.pattern);
            if (r && r.length >= MIN_TAUGHT) return r;
        }
        if (cfg && cfg.sig) {
            const r = detectTopics(root, base, cfg.sig);
            if (r) return r;
        }
        return detectTopics(root, base);
    }

    function detectNextPage(root, base) {
        base = base || location.href;
        let baseOrigin;
        try { baseOrigin = new URL(base).origin; } catch (_) { baseOrigin = location.origin; }
        // rel=next first (same-site only, like everything else we fetch)
        let el = root.querySelector('a[rel~="next"], link[rel~="next"]');
        if (el) {
            const raw = el.getAttribute('href');
            if (raw) {
                try {
                    const u = new URL(raw, base);
                    if (u.origin === baseOrigin) return norm(u.href, base);
                } catch (_) {}
            }
        }
        // then anchors whose text/aria look like "next" — no chrome exclusion here,
        // pagination legitimately lives inside <nav> on many forums
        const rx = /^(next|older|more|›|»|>>|→|next\s*page|next\s*»?)$/i;
        for (const a of root.querySelectorAll('a[href]')) {
            const t = (a.textContent || '').trim();
            const al = (a.getAttribute('aria-label') || '').trim();
            if (rx.test(t) || /next|older/i.test(al)) {
                const raw = a.getAttribute('href');
                if (!raw || raw.startsWith('#')) continue;
                try {
                    const u = new URL(raw, base);
                    if (u.origin === baseOrigin) return norm(u.href, base);
                } catch (_) {}
            }
        }
        return null;
    }

    // ---------------- Teaching ----------------
    // From one example topic URL pasted by the user, derive a reusable URL pattern for
    // the site. The example itself is never stored — only the generalized pattern and
    // the anchor's structural signature.
    const escRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pathSegs = (p) => p.replace(/\/+$/, '').split('/').filter(Boolean);

    function generalizeSeg(vals, seg, isFirst) {
        if (vals && vals.length > 1) {
            // cluster-derived: this path position varies across topic links
            if (vals.every(v => /^\d+$/.test(v))) return '\\d+';
            if (vals.every(v => /\.\d+$/.test(v))) return '[^/]+\\.\\d+';   // XenForo: title.12345
            if (vals.every(v => /^\d+-/.test(v))) return '\\d+-[^/]+';      // id-title
            return '[^/]+';
        }
        if (vals && vals.length === 1) return escRx(vals[0]);               // constant across cluster
        // single-example fallback: keep the leading section literal, generalize the rest
        if (isFirst) return escRx(seg);
        if (/^\d+$/.test(seg)) return '\\d+';
        if (/\.\d+$/.test(seg)) return '[^/]+\\.\\d+';
        if (/^\d+-/.test(seg)) return '\\d+-[^/]+';
        return '[^/]+';
    }

    function derivePattern(exUrl, cluster) {
        const exSegsList = pathSegs(exUrl.pathname);
        const useCluster = cluster.length >= 3;
        const parts = exSegsList.map((seg, i) => {
            let vals = null;
            if (useCluster) vals = Array.from(new Set(cluster.map(u => pathSegs(u.pathname)[i])));
            return generalizeSeg(vals, seg, i === 0);
        });
        let src = exSegsList.length ? '^/' + parts.join('/') : '^/';
        if (exUrl.search) src += escRx(exUrl.search).replace(/\d+/g, '\\d+');
        return src;
    }

    function analyzeExample(exampleRaw) {
        let exUrl;
        try { exUrl = new URL(norm((exampleRaw || '').trim())); } catch (_) {
            return { error: 'That does not look like a valid link.' };
        }
        if (exUrl.origin !== location.origin) {
            return { error: 'That link is on a different site (' + exUrl.hostname + ') — open that forum first.' };
        }
        const ex = norm(exUrl.href);
        const anchors = Array.from(document.querySelectorAll('a[href]')).filter(a => {
            const raw = a.getAttribute('href');
            if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel):/i.test(raw)) return false;
            try { return norm(new URL(raw, location.href).href) === ex; } catch (_) { return false; }
        });
        if (!anchors.length) {
            return { error: 'That link is not on this page — open the index page that lists it, then teach.' };
        }
        // The same topic often has several anchors (title, last-post); the wordiest one
        // is the title link.
        const example = anchors.reduce((p, c) =>
            (c.textContent || '').trim().length >= (p.textContent || '').trim().length ? c : p);
        const sig = signature(example, true);

        // Cluster of same-shaped URLs on this page (same depth + same leading segment):
        // lets derivePattern see which path positions actually vary.
        const exSegsList = pathSegs(exUrl.pathname);
        const cluster = [];
        for (const a of document.querySelectorAll('a[href]')) {
            const raw = a.getAttribute('href');
            if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel):/i.test(raw)) continue;
            let u;
            try { u = new URL(raw, location.href); } catch (_) { continue; }
            if (u.origin !== exUrl.origin) continue;
            const s = pathSegs(u.pathname);
            if (s.length !== exSegsList.length) continue;
            if (exSegsList.length && s[0] !== exSegsList[0]) continue;
            if (!!u.search !== !!exUrl.search) continue;
            cluster.push(u);
        }

        const pattern = derivePattern(exUrl, cluster);
        const count = (detectByPattern(document, location.href, pattern) || []).length;
        return { pattern, sig, count };
    }

    // ---------------- UI: floating bar ----------------
    let bar;
    function buildBar() {
        if (bar) return bar;
        bar = document.createElement('div');
        Object.assign(bar.style, {
            position: 'fixed', zIndex: 2147483647, right: '0px', bottom: '0px',
            display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '4px',
            padding: '6px 8px', borderRadius: '10px',
            background: 'rgba(28,28,32,0.92)', color: '#fff',
            font: '13px/1.2 system-ui, sans-serif',
            boxShadow: '0 4px 14px rgba(0,0,0,0.35)', userSelect: 'none',
            backdropFilter: 'blur(4px)'
        });
        // Restore a dragged position. Offsets are measured against the content area
        // (documentElement.clientWidth/Height, which exclude the scrollbar) so "flush in
        // the corner" is a true 0. Snap near-edge values to 0 and clamp so a narrower page
        // can't hide it.
        const de = document.documentElement;
        const pos = (() => { try { return JSON.parse(GM_getValue(POS_KEY, 'null')); } catch (_) { return null; } })();
        if (pos) {
            let r = Math.min(Math.max(0, pos.right | 0), Math.max(0, de.clientWidth - 40));
            let b = Math.min(Math.max(0, pos.bottom | 0), Math.max(0, de.clientHeight - 30));
            if (r < 12) r = 0;
            if (b < 12) b = 0;
            bar.style.right = r + 'px';
            bar.style.bottom = b + 'px';
        }
        document.body.appendChild(bar);
        makeDraggable(bar);
        return bar;
    }

    function mkBtn(label, title) {
        const b = document.createElement('button');
        b.textContent = label;
        b.title = title || '';
        Object.assign(b.style, {
            cursor: 'pointer', border: 'none', borderRadius: '7px',
            padding: '5px 9px', font: 'inherit', fontWeight: '600',
            background: 'rgba(255,255,255,0.14)', color: '#fff'
        });
        b.addEventListener('mouseenter', () => b.style.background = 'rgba(255,255,255,0.26)');
        b.addEventListener('mouseleave', () => b.style.background = 'rgba(255,255,255,0.14)');
        return b;
    }

    function mkLabel(text) {
        const s = document.createElement('span');
        s.textContent = text;
        s.style.padding = '0 4px';
        s.style.whiteSpace = 'nowrap';
        return s;
    }

    function mkTitle(text) {
        const s = document.createElement('div');
        s.textContent = text;
        Object.assign(s.style, {
            maxWidth: '240px', overflow: 'hidden', textOverflow: 'ellipsis',
            whiteSpace: 'nowrap', textAlign: 'center', fontSize: '11px',
            opacity: '0.75', cursor: 'pointer'
        });
        return s;
    }

    function mkRow() {
        const r = document.createElement('div');
        Object.assign(r.style, { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' });
        return r;
    }

    function makeDraggable(el) {
        // Measure against the content area (clientWidth/Height exclude the scrollbar) so
        // the coordinate space matches getBoundingClientRect and CSS right/bottom.
        // Move/up listeners only live for the duration of a drag.
        const vw = () => document.documentElement.clientWidth;
        const vh = () => document.documentElement.clientHeight;
        el.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
            const sx = e.clientX, sy = e.clientY;
            const r0 = el.getBoundingClientRect();
            const sr = vw() - r0.right, sb = vh() - r0.bottom;
            const onMove = (ev) => {
                el.style.right = Math.max(0, sr - (ev.clientX - sx)) + 'px';
                el.style.bottom = Math.max(0, sb - (ev.clientY - sy)) + 'px';
            };
            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                const r = el.getBoundingClientRect();
                let right = Math.round(vw() - r.right);
                let bottom = Math.round(vh() - r.bottom);
                if (right < 12) right = 0;   // snap flush to the corner
                if (bottom < 12) bottom = 0;
                GM_setValue(POS_KEY, JSON.stringify({ right, bottom }));
            };
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
            e.preventDefault();
        });
    }

    function clearBar() { if (bar) bar.textContent = ''; }

    // ---------------- Tour lifecycle ----------------
    function startTour(topics, nextPage) {
        const tour = {
            urls: topics.map(t => t.url),
            titles: topics.map(t => t.text),
            source: norm(location.href),
            sourceTitle: (document.title || location.hostname).trim(),
            nextPage: nextPage || null,
            ts: Date.now()
        };
        saveTour(tour);
        go(tour.urls[0]);
    }

    // Append a freshly-detected page of topics onto the running tour (dedup against
    // what we already have). Returns the first newly-added URL, or null.
    function appendPage(tour, topics, newNext, newNextBase) {
        const existing = new Set(tour.urls);
        const addUrls = [], addTitles = [];
        for (const t of topics) {
            if (!existing.has(t.url)) { existing.add(t.url); addUrls.push(t.url); addTitles.push(t.text); }
        }
        if (!addUrls.length) return null;
        tour.urls = tour.urls.concat(addUrls);
        tour.titles = tour.titles.concat(addTitles);
        const nn = newNext ? norm(newNext, newNextBase) : null;
        tour.nextPage = (nn && !tour.urls.includes(nn) && nn !== tour.nextPage) ? nn : null;
        saveTour(tour);
        return addUrls[0];
    }

    // Fetch a page's HTML without navigating. GM_xmlhttpRequest is tried first because it
    // is not subject to the page's CSP/connect-src (a plain fetch often is); plain fetch is
    // the fallback for managers that don't provide it.
    function fetchHtml(url) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: 'GET', url,
                    onload: (r) => (r.status >= 200 && r.status < 400) ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status)),
                    onerror: () => reject(new Error('network')),
                    ontimeout: () => reject(new Error('timeout')),
                    timeout: 15000
                });
            } else {
                fetch(url, { credentials: 'same-origin' })
                    .then(r => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
                    .then(resolve, reject);
            }
        });
    }

    // End-of-tour: pull the next results page in the background, parse it, append its
    // topics, and jump to the first new one. Falls back to a visible navigation only if
    // the page can't be fetched/parsed (e.g. JS-rendered lists).
    async function pullNextPage(tour, nextBtn) {
        if (!tour.nextPage) return;
        const target = tour.nextPage;
        if (nextBtn) { nextBtn.textContent = '…'; nextBtn.title = 'Loading next page…'; }
        try {
            const html = await fetchHtml(target);
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const site = getSiteFor(new URL(target).hostname);
            const topics = detectForSite(doc, target, site ? site.cfg : null);
            if (!topics) throw new Error('no topics in fetched page');
            const newNext = detectNextPage(doc, target);
            const first = appendPage(tour, topics, newNext, target);
            if (!first) throw new Error('all duplicates');
            go(first);
        } catch (_) {
            // Fallback: navigate to the next page visibly, then auto-append on load.
            GM_setValue(RESUME_KEY, 'append');
            go(target);
        }
    }

    // ---------------- Render ----------------
    function render() {
        const site = getSiteFor(location.hostname);
        if (!site) return; // opt-in: dormant on unlisted sites (add via menu → Settings)

        const tour = loadTour();
        const here = norm(location.href);

        // On a topic that belongs to the active tour?
        if (tour && tour.urls) {
            let idx = tour.urls.indexOf(here);
            // Forums may redirect a stored topic URL deeper — Discourse sends logged-in
            // users to the last-read post (/t/slug/123 → /t/slug/123/4). Fall back to a
            // prefix match with a separator so /topic/12 can't claim /topic/123.
            if (idx === -1) idx = tour.urls.findIndex(u => here.startsWith(u + '/') || here.startsWith(u + '?'));
            if (idx !== -1) {
                buildBar(); clearBar();

                const title = mkTitle(tour.sourceTitle || 'Forum');
                title.title = 'Back to: ' + (tour.sourceTitle || tour.source);
                if (tour.source) title.addEventListener('click', () => go(tour.source));

                const row = mkRow();
                const back = mkBtn('◀', idx === 0 ? 'Back to index' : 'Previous topic');
                const next = mkBtn('▶', 'Next topic');
                const lbl = mkLabel(`${idx + 1} / ${tour.urls.length}`);
                lbl.style.cursor = 'pointer';
                lbl.title = 'Click to jump to a topic number';

                // Click the counter -> inline number box -> Enter jumps to that topic.
                lbl.addEventListener('click', () => {
                    const input = document.createElement('input');
                    input.type = 'number';
                    input.min = '1'; input.max = String(tour.urls.length);
                    input.value = String(idx + 1);
                    Object.assign(input.style, {
                        width: '58px', font: 'inherit', textAlign: 'center',
                        borderRadius: '6px', border: '1px solid rgba(255,255,255,0.3)',
                        background: '#fff', color: '#111'
                    });
                    let done = false;
                    const commit = () => {
                        if (done) return; done = true;
                        const n = parseInt(input.value, 10);
                        if (!isNaN(n) && n >= 1 && n <= tour.urls.length && n !== idx + 1) go(tour.urls[n - 1]);
                        else input.replaceWith(lbl); // no-op / cancel -> restore label
                    };
                    input.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') { e.preventDefault(); commit(); }
                        else if (e.key === 'Escape') { done = true; input.replaceWith(lbl); }
                    });
                    input.addEventListener('blur', commit);
                    lbl.replaceWith(input);
                    input.focus(); input.select();
                });

                back.addEventListener('click', () => {
                    if (idx > 0) go(tour.urls[idx - 1]);
                    else if (tour.source) go(tour.source);
                });

                const isLast = idx === tour.urls.length - 1;
                const canChain = AUTO_CHAIN && tour.nextPage;
                if (isLast && canChain) { next.textContent = '⏭'; next.title = 'Pull next page → first new topic'; }
                if (isLast && !canChain) { next.style.opacity = '0.4'; next.style.cursor = 'default'; }
                next.addEventListener('click', () => {
                    if (!isLast) go(tour.urls[idx + 1]);
                    else if (canChain) pullNextPage(tour, next);
                });

                row.append(back, lbl, next);
                bar.append(title, row);
                return;
            }
        }

        // Not in a tour here — is this a list page?
        const topics = detectForSite(document, location.href, site.cfg);
        const resume = GM_getValue(RESUME_KEY, '');

        if (topics && topics.length) {
            const nextPage = detectNextPage(document, location.href);

            // Arrived here as the fallback continuation of a running tour: append + jump in.
            if (resume === 'append' && tour && tour.urls) {
                GM_deleteValue(RESUME_KEY);
                const first = appendPage(tour, topics, nextPage, location.href);
                if (first) { go(first); return; }
            }
            if (resume) GM_deleteValue(RESUME_KEY);

            buildBar(); clearBar();
            const row = mkRow();
            const start = mkBtn(`📑 ${topics.length} topics — Start`, 'Capture these topics and open the first');
            start.addEventListener('click', () => startTour(topics, nextPage));
            const hide = mkBtn('✕', 'Hide');
            hide.addEventListener('click', () => bar.remove());
            row.append(start, hide);
            bar.append(row);
        } else if (resume) {
            GM_deleteValue(RESUME_KEY); // stale flag, nothing to continue here
        }
    }

    function rescan() {
        if (bar) { bar.remove(); bar = null; }
        render();
    }

    // ---------------- Settings dialog ----------------
    function openSettings() {
        if (document.getElementById('fs-settings')) return;

        // Host element + Shadow DOM so the host page's CSS can't cascade into the
        // panel (same approach as Open-Links-in-New-Tab). All nodes are built with
        // createElement + textContent — never innerHTML (Trusted Types CSP sites
        // throw on innerHTML and silently abort the build).
        const host = document.createElement('div');
        host.id = 'fs-settings';
        host.style.cssText = 'all: initial;';
        const root = host.attachShadow({ mode: 'open' });

        const resetStyle = document.createElement('style');
        resetStyle.textContent = ':host { all: initial; } * { box-sizing: border-box; }';
        root.appendChild(resetStyle);

        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; inset: 0; z-index: 2147483646;
            background: rgba(0,0,0,0.6); display: flex;
            align-items: center; justify-content: center; font-family: system-ui, sans-serif;
        `;

        const panel = document.createElement('div');
        panel.style.cssText = `
            background: #1e1e2e; color: #cdd6f4; border-radius: 10px;
            padding: 20px 24px; width: 480px; max-height: 80vh;
            display: flex; flex-direction: column; gap: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5); overflow: hidden;
        `;

        const title = document.createElement('div');
        title.style.cssText = 'font-size: 15px; font-weight: 700; color: #89b4fa;';
        title.textContent = 'Forum Stumbler — Settings';

        const desc = document.createElement('div');
        desc.style.cssText = 'font-size: 12px; color: #9399b2; line-height: 1.45;';
        const descMain = document.createElement('div');
        descMain.textContent = 'Forum Stumbler only runs on the sites listed here (opt-in). Everywhere else it stays dormant.';
        const descTeach = document.createElement('div');
        descTeach.style.cssText = 'margin-top: 4px; color: #6c7086; font-style: italic;';
        descTeach.textContent = 'To teach a site its topic-link shape: open its topic-list page, click Teach, and paste any topic link from that page. Only the derived pattern is stored — never the link itself.';
        desc.appendChild(descMain);
        desc.appendChild(descTeach);

        function smallBtn(label, bg, fg) {
            const b = document.createElement('button');
            b.textContent = label;
            b.style.cssText = 'padding: 4px 10px; border-radius: 6px; border: none; font-size: 12px;' +
                'font-weight: 700; cursor: pointer; background: ' + bg + '; color: ' + (fg || '#1e1e2e') + '; white-space: nowrap;';
            return b;
        }

        // Add row
        const addRow = document.createElement('div');
        addRow.style.cssText = 'display: flex; gap: 6px;';
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'e.g. forum.example.com';
        input.style.cssText = `
            flex: 1; padding: 6px 10px; border-radius: 6px; border: 1px solid #45475a;
            background: #313244; color: #cdd6f4; font-size: 13px; outline: none;
        `;
        const addBtn = smallBtn('Add', '#89b4fa');
        const addCurrentBtn = smallBtn('+ This Site', '#a6e3a1');
        addCurrentBtn.title = 'Add the current site (' + location.hostname + ')';
        addRow.append(input, addBtn, addCurrentBtn);

        // Site list
        const list = document.createElement('div');
        list.style.cssText = `
            overflow-y: auto; display: flex; flex-direction: column; gap: 5px;
            flex: 1; min-height: 0; max-height: 40vh; padding-right: 4px;
        `;

        // Teach area (shown when a site's Teach button is clicked)
        const teachArea = document.createElement('div');
        teachArea.style.cssText = 'display: none; flex-direction: column; gap: 6px; background: #313244; border-radius: 6px; padding: 10px;';

        // Status line
        const ioStatus = document.createElement('span');
        ioStatus.style.cssText = 'font-size: 12px; color: #a6e3a1; margin-left: 4px;';
        function flashStatus(msg, color) {
            ioStatus.style.color = color || '#a6e3a1';
            ioStatus.textContent = msg;
            clearTimeout(ioStatus._t);
            ioStatus._t = setTimeout(() => { ioStatus.textContent = ''; }, 4000);
        }

        function hideTeach() {
            teachArea.style.display = 'none';
            while (teachArea.firstChild) teachArea.removeChild(teachArea.firstChild);
        }

        function showTeach(domain) {
            teachArea.style.display = 'flex';
            while (teachArea.firstChild) teachArea.removeChild(teachArea.firstChild);

            const lbl = document.createElement('div');
            lbl.style.cssText = 'font-size: 12px; color: #cdd6f4;';
            lbl.textContent = 'Teach ' + domain + ' — paste a topic link that appears on the current page:';

            const row = document.createElement('div');
            row.style.cssText = 'display: flex; gap: 6px;';
            const tInput = document.createElement('input');
            tInput.type = 'text';
            tInput.placeholder = 'https://…';
            tInput.style.cssText = input.style.cssText;
            const analyzeBtn = smallBtn('Analyze', '#89b4fa');
            const cancelBtn = smallBtn('Cancel', '#45475a', '#cdd6f4');
            row.append(tInput, analyzeBtn, cancelBtn);

            const result = document.createElement('div');
            result.style.cssText = 'font-size: 12px; line-height: 1.4; word-break: break-all;';
            const saveRow = document.createElement('div');
            saveRow.style.cssText = 'display: none; gap: 6px;';

            function analyze() {
                saveRow.style.display = 'none';
                while (saveRow.firstChild) saveRow.removeChild(saveRow.firstChild);
                const res = analyzeExample(tInput.value);
                if (res.error) {
                    result.style.color = '#f38ba8';
                    result.textContent = res.error;
                    return;
                }
                result.style.color = res.count >= MIN_TAUGHT ? '#a6e3a1' : '#f9e2af';
                result.textContent = 'Pattern: ' + res.pattern + ' — matches ' + res.count +
                    ' link' + (res.count === 1 ? '' : 's') + ' on this page.' +
                    (res.count < MIN_TAUGHT ? ' That looks too few — try a different link, or Save anyway.' : '');
                const saveBtn = smallBtn('Save pattern', '#a6e3a1');
                saveBtn.addEventListener('click', () => {
                    const sites = getSites();
                    sites[domain] = { pattern: res.pattern, sig: res.sig };
                    saveSites(sites);
                    hideTeach();
                    renderList();
                    flashStatus('Saved pattern for ' + domain + '.');
                });
                saveRow.appendChild(saveBtn);
                saveRow.style.display = 'flex';
            }

            analyzeBtn.addEventListener('click', analyze);
            tInput.addEventListener('keydown', e => { if (e.key === 'Enter') analyze(); });
            cancelBtn.addEventListener('click', hideTeach);

            teachArea.append(lbl, row, result, saveRow);
            tInput.focus();
        }

        function renderList() {
            while (list.firstChild) list.removeChild(list.firstChild);
            const sites = getSites();
            const domains = Object.keys(sites).sort();
            if (!domains.length) {
                const empty = document.createElement('div');
                empty.style.cssText = 'color: #6c7086; font-size: 13px; text-align: center; padding: 12px 0;';
                empty.textContent = 'No sites yet — Forum Stumbler is dormant everywhere.';
                list.appendChild(empty);
                return;
            }
            const h = location.hostname.toLowerCase();
            domains.forEach(d => {
                const cfg = sites[d] || {};
                const row = document.createElement('div');
                row.style.cssText = `
                    display: flex; align-items: center; gap: 6px;
                    background: #313244; border-radius: 6px; padding: 6px 10px;
                `;
                const label = document.createElement('span');
                label.style.cssText = 'font-size: 13px; word-break: break-all; flex: 1;';
                label.textContent = d;
                row.appendChild(label);

                if (cfg.pattern) {
                    const badge = document.createElement('span');
                    badge.style.cssText = 'font-size: 11px; color: #a6e3a1; flex-shrink: 0;';
                    badge.textContent = 'taught';
                    badge.title = 'Pattern: ' + cfg.pattern;
                    row.appendChild(badge);
                }

                const onSite = h === d || h.endsWith('.' + d);
                const teachBtn = smallBtn(cfg.pattern ? 'Re-teach' : 'Teach', '#89b4fa');
                if (onSite) {
                    teachBtn.title = 'Paste a topic link from the current page';
                    teachBtn.addEventListener('click', () => showTeach(d));
                } else {
                    teachBtn.style.opacity = '0.4';
                    teachBtn.style.cursor = 'default';
                    teachBtn.title = 'Open a topic-list page on ' + d + ' to teach it';
                }
                row.appendChild(teachBtn);

                if (cfg.pattern) {
                    const forgetBtn = smallBtn('Forget', '#f9e2af');
                    forgetBtn.title = 'Forget the taught pattern (falls back to auto-detection)';
                    forgetBtn.addEventListener('click', () => {
                        const s = getSites();
                        s[d] = { pattern: null, sig: null };
                        saveSites(s);
                        renderList();
                        flashStatus('Forgot pattern for ' + d + '.');
                    });
                    row.appendChild(forgetBtn);
                }

                const removeBtn = document.createElement('button');
                removeBtn.textContent = '✕';
                removeBtn.style.cssText = `
                    background: none; border: none; color: #f38ba8;
                    cursor: pointer; font-size: 14px; padding: 0 4px; flex-shrink: 0;
                `;
                removeBtn.title = 'Remove ' + d;
                removeBtn.addEventListener('click', () => {
                    const s = getSites();
                    delete s[d];
                    saveSites(s);
                    renderList();
                });
                row.appendChild(removeBtn);

                list.appendChild(row);
            });
        }

        function addSite(raw) {
            const d = normDomain(raw);
            if (!d) return;
            const sites = getSites();
            if (sites[d]) { flashStatus('Already listed.', '#f9e2af'); return; }
            sites[d] = { pattern: null, sig: null };
            saveSites(sites);
            renderList();
            input.value = '';
        }

        addBtn.addEventListener('click', () => addSite(input.value));
        input.addEventListener('keydown', e => { if (e.key === 'Enter') addSite(input.value); });
        addCurrentBtn.addEventListener('click', () => addSite(location.hostname));

        // Import / Export (whole config: sites + taught patterns, as JSON)
        const ioRow = document.createElement('div');
        ioRow.style.cssText = 'display: flex; gap: 6px; align-items: center;';
        const exportBtn = smallBtn('Export', '#fab387');
        exportBtn.title = 'Download the site list (with taught patterns) as a .json file';
        const importBtn = smallBtn('Import', '#f9e2af');
        importBtn.title = 'Load a .json file and merge with the existing list';

        exportBtn.addEventListener('click', () => {
            const sites = getSites();
            const n = Object.keys(sites).length;
            if (!n) { flashStatus('Nothing to export.', '#f38ba8'); return; }
            const blob = new Blob([JSON.stringify({ sites }, null, 2) + '\n'], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'forum-stumbler-sites.json';
            document.documentElement.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            flashStatus('Exported ' + n + ' site' + (n === 1 ? '' : 's') + '.');
        });

        importBtn.addEventListener('click', () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = '.json,application/json';
            fileInput.style.display = 'none';
            fileInput.addEventListener('change', e => {
                const file = e.target.files && e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = ev => {
                    let parsed;
                    try { parsed = JSON.parse(String(ev.target.result || '')); } catch (_) {
                        flashStatus('Not a valid JSON file.', '#f38ba8');
                        return;
                    }
                    const incoming = (parsed && typeof parsed === 'object')
                        ? ((parsed.sites && typeof parsed.sites === 'object') ? parsed.sites : parsed)
                        : null;
                    if (!incoming) { flashStatus('Not a valid sites file.', '#f38ba8'); return; }
                    const sites = getSites();
                    let n = 0;
                    for (const [d, cfg] of Object.entries(incoming)) {
                        const dom = normDomain(String(d));
                        if (!dom) continue;
                        sites[dom] = {
                            pattern: (cfg && typeof cfg.pattern === 'string') ? cfg.pattern : null,
                            sig: (cfg && typeof cfg.sig === 'string') ? cfg.sig : null
                        };
                        n++;
                    }
                    saveSites(sites);
                    renderList();
                    flashStatus('Imported ' + n + ' site' + (n === 1 ? '' : 's') + '.');
                };
                reader.onerror = () => flashStatus('Failed to read file.', '#f38ba8');
                reader.readAsText(file);
            });
            document.documentElement.appendChild(fileInput);
            fileInput.click();
            setTimeout(() => fileInput.remove(), 1000);
        });

        ioRow.append(exportBtn, importBtn, ioStatus);

        const closeBtn = smallBtn('Close', '#45475a', '#cdd6f4');
        closeBtn.style.alignSelf = 'flex-end';
        const closeAll = () => { host.remove(); rescan(); }; // re-scan so a just-added site lights up immediately
        closeBtn.addEventListener('click', closeAll);
        overlay.addEventListener('click', e => { if (e.target === overlay) closeAll(); });

        renderList();
        panel.append(title, desc, addRow, list, teachArea, ioRow, closeBtn);
        overlay.appendChild(panel);
        root.appendChild(overlay);
        document.documentElement.appendChild(host);
    }

    // ---------------- Menu commands ----------------
    GM_registerMenuCommand('Forum Stumbler: settings', openSettings);
    GM_registerMenuCommand('Forum Stumbler: re-scan this page', rescan);
    GM_registerMenuCommand('Forum Stumbler: clear saved tour', () => {
        GM_deleteValue(TOUR_KEY); GM_deleteValue(RESUME_KEY);
        if (bar) { bar.remove(); bar = null; }
    });

    // ---------------- Boot ----------------
    render();
    // Forums often lazy-render lists. If nothing was found yet on an opted-in site,
    // watch DOM changes for a while instead of a single fixed retry.
    if (getSiteFor(location.hostname) && !bar) {
        let settleTimer = null;
        const mo = new MutationObserver(() => {
            if (settleTimer) clearTimeout(settleTimer);
            settleTimer = setTimeout(() => {
                if (!bar) render();
                if (bar) mo.disconnect();
            }, 400);
        });
        if (document.body) mo.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => mo.disconnect(), 12000);
    }
})();
