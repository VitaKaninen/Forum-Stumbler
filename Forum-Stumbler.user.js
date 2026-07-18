// ==UserScript==
// @name        Forum Stumbler
// @namespace   https://github.com/VitaKaninen
// @version     0.3.0
// @author      VitaKaninen
// @description Capture every topic link on a forum index page, then walk them with Back/Next buttons — no tabs. Shows the source forum name and pulls the next page of results in the background.
// @match       *://*/*
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_deleteValue
// @grant       GM_registerMenuCommand
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
    const AUTO_CHAIN = true;              // pull the forum's "next page" of results at end of a tour
    const MIN_CLUSTER = 4;                // need at least this many links to call it a topic list
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

    // Hrefs that are clearly NOT topics (nav/pagination/account/etc).
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

    function signature(a) {
        // Structural fingerprint of an anchor: tag+class chain of up to 4 ancestors.
        let parts = [];
        let el = a;
        for (let i = 0; i < 4 && el && el.tagName; i++) {
            const cls = (el.getAttribute('class') || '')
                .trim().split(/\s+/).slice(0, 2)
                .map(c => c.replace(/\d+/g, '#')).join('.');
            parts.push(el.tagName.toLowerCase() + (cls ? '.' + cls : ''));
            el = el.parentElement;
        }
        return parts.join('>');
    }

    // ---------------- Detection ----------------
    // Works on either the live document or a fetched-and-parsed one; `base` is that
    // document's own URL so relative hrefs resolve correctly.
    function detectTopics(root, base) {
        base = base || location.href;
        let baseOrigin;
        try { baseOrigin = new URL(base).origin; } catch (_) { return null; }
        const here = norm(base, base);
        const anchors = Array.from(root.querySelectorAll('a[href]'));
        const groups = new Map();

        for (const a of anchors) {
            const raw = a.getAttribute('href');
            if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel):/i.test(raw)) continue;
            let url;
            try { url = new URL(raw, base); } catch (_) { continue; }
            if (url.origin !== baseOrigin) continue;              // same-site topics only
            const nurl = norm(url.href, base);
            if (nurl === here) continue;                          // not the current page
            if (NEGATIVE.test(nurl)) continue;
            if (inChrome(a)) continue;
            // Skip in-topic pagination ("Go to page: 1, 2") and paging arrows: their
            // visible text is just a number or a single symbol, never a topic title.
            if (a.closest('.pagination, .pager, .pages, [class*="pagination"], [class*="pager"]')) continue;
            const text = (a.textContent || '').trim();
            if (text.length < 2) continue;            // single chars: » « ‹ › etc.
            if (/^\d{1,5}$/.test(text)) continue;     // bare page numbers: 1, 2, 3…
            if (!text) continue;

            const sig = signature(a);
            if (!groups.has(sig)) groups.set(sig, []);
            groups.get(sig).push({ url: nurl, text });
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
        return best; // array of {url, text} in document order, or null
    }

    function detectNextPage(root, base) {
        base = base || location.href;
        let baseOrigin;
        try { baseOrigin = new URL(base).origin; } catch (_) { baseOrigin = location.origin; }
        // rel=next first
        let el = root.querySelector('a[rel~="next"], link[rel~="next"]');
        if (el) {
            const raw = el.getAttribute('href');
            if (raw) { try { return norm(new URL(raw, base).href, base); } catch (_) {} }
        }
        // then anchors whose text/aria look like "next"
        const rx = /^(next|older|more|›|»|>>|→|next\s*page|next\s*»?)$/i;
        for (const a of root.querySelectorAll('a[href]')) {
            const t = (a.textContent || '').trim();
            const al = (a.getAttribute('aria-label') || '').trim();
            if ((rx.test(t) || /next|older/i.test(al)) && !inChrome(a)) {
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

    // ---------------- UI ----------------
    let bar;
    function buildBar() {
        if (bar) return bar;
        bar = document.createElement('div');
        Object.assign(bar.style, {
            position: 'fixed', zIndex: 2147483647, right: '16px', bottom: '16px',
            display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '4px',
            padding: '6px 8px', borderRadius: '10px',
            background: 'rgba(28,28,32,0.92)', color: '#fff',
            font: '13px/1.2 system-ui, sans-serif',
            boxShadow: '0 4px 14px rgba(0,0,0,0.35)', userSelect: 'none',
            backdropFilter: 'blur(4px)'
        });
        const pos = (() => { try { return JSON.parse(GM_getValue(POS_KEY, 'null')); } catch (_) { return null; } })();
        if (pos) { bar.style.right = pos.right + 'px'; bar.style.bottom = pos.bottom + 'px'; }
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
        let sx, sy, sr, sb, drag = false;
        el.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            drag = true;
            sx = e.clientX; sy = e.clientY;
            const r = el.getBoundingClientRect();
            sr = window.innerWidth - r.right; sb = window.innerHeight - r.bottom;
            e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
            if (!drag) return;
            const right = Math.max(0, sr - (e.clientX - sx));
            const bottom = Math.max(0, sb - (e.clientY - sy));
            el.style.right = right + 'px'; el.style.bottom = bottom + 'px';
        });
        window.addEventListener('mouseup', () => {
            if (!drag) return; drag = false;
            const r = el.getBoundingClientRect();
            GM_setValue(POS_KEY, JSON.stringify({
                right: Math.round(window.innerWidth - r.right),
                bottom: Math.round(window.innerHeight - r.bottom)
            }));
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

    // End-of-tour: fetch the next results page in the background, parse it, append its
    // topics, and jump to the first new one. Falls back to a visible navigation if the
    // page can't be fetched/parsed (e.g. JS-rendered lists).
    async function pullNextPage(tour, nextBtn) {
        if (!tour.nextPage) return;
        const target = tour.nextPage;
        if (nextBtn) { nextBtn.textContent = '…'; nextBtn.title = 'Loading next page…'; }
        try {
            const resp = await fetch(target, { credentials: 'same-origin' });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const html = await resp.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const topics = detectTopics(doc, target);
            if (!topics || topics.length < MIN_CLUSTER) throw new Error('no topics in fetched page');
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
        const tour = loadTour();
        const here = norm(location.href);

        // On a topic that belongs to the active tour?
        if (tour && tour.urls) {
            const idx = tour.urls.indexOf(here);
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
        const topics = detectTopics(document, location.href);
        const resume = GM_getValue(RESUME_KEY, '');

        if (topics && topics.length >= MIN_CLUSTER) {
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

    // ---------------- Menu commands ----------------
    GM_registerMenuCommand('Forum Stumbler: re-scan this page', () => { if (bar) { bar.remove(); bar = null; } render(); });
    GM_registerMenuCommand('Forum Stumbler: clear saved tour', () => {
        GM_deleteValue(TOUR_KEY); GM_deleteValue(RESUME_KEY);
        if (bar) { bar.remove(); bar = null; }
    });

    // ---------------- Boot ----------------
    // Forums often lazy-render lists; try now and once more shortly after.
    render();
    setTimeout(() => { if (!bar) render(); }, 1200);
})();
