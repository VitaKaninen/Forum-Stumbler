// ==UserScript==
// @name        Forum Stumbler
// @namespace   https://github.com/VitaKaninen
// @version     0.8.0
// @author      VitaKaninen
// @description Capture every topic link on a forum index page, then walk them with Back/Next buttons — no tabs. Opt-in per site with subforum scoping, guided click-to-teach, numeric-pagination detection, and live re-scan for lazy-loaded lists.
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
    // Tour state is per-tab (sessionStorage): it lives as long as the tab and never
    // leaks into other tabs. Position + site list are global (GM storage).
    const TOUR_KEY = 'fs_tour';           // sessionStorage: { urls, titles, source, sourceTitle, nextPage, ts }
    const RESUME_KEY = 'fs_resume';       // sessionStorage: '' | 'append' — set when we navigate to a next page as a fallback
    const POS_KEY = 'fs_barpos';          // GM: { right, bottom }
    const SITES_KEY = 'fs_sites';         // GM: { "<host>": { all, prefixes[], pattern, sig, nextSig } }
    const AUTO_CHAIN = true;              // pull the forum's "next page" of results at end of a tour
    const MIN_CLUSTER = 4;                // heuristic: need at least this many links to call it a topic list
    const MIN_TAUGHT = 2;                 // taught signature/pattern: trust smaller lists
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
    // taught detection overrides this list.
    const NEGATIVE = /(\/login|\/logout|\/register|\/signup|\/sign-in|\/profile|\/members?\/|\/users?\/|\/tag[s]?\/|\/categor|\/forum[s]?\/?$|[?&]page=|\/page\/\d|[?&]start=\d|\/search|\/rss|\/feed|\.(png|jpe?g|gif|svg|css|js|pdf|zip)(\?|$))/i;

    // Forward-pagination vocabulary — deliberately narrow (this is not the "don't open
    // in a new tab" list from Open-Links-in-New-Tab; things like best/hot/top/reply/
    // "read more" are not list pagination and must not send the tour off-track).
    // "previous"/"newer"/back-arrows are excluded so we never walk backwards.
    const NEXT_TEXT = /^(next|next\s*page|older|older\s*posts?|more|load\s*more|show\s*more|next\s*[»›→]|»|›|→|>>)$/i;

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
        try { return JSON.parse(sessionStorage.getItem(TOUR_KEY) || 'null'); } catch (_) { return null; }
    };
    const saveTour = (t) => { try { sessionStorage.setItem(TOUR_KEY, JSON.stringify(t)); } catch (_) {} };
    const clearTourState = () => {
        try { sessionStorage.removeItem(TOUR_KEY); sessionStorage.removeItem(RESUME_KEY); } catch (_) {}
    };
    const getResume = () => { try { return sessionStorage.getItem(RESUME_KEY) || ''; } catch (_) { return ''; } };
    const setResume = (v) => { try { sessionStorage.setItem(RESUME_KEY, v); } catch (_) {} };
    const delResume = () => { try { sessionStorage.removeItem(RESUME_KEY); } catch (_) {} };
    const go = (url) => { location.href = url; };

    // One-time cleanup: tours lived in GM storage before 0.7.0.
    if (GM_getValue(TOUR_KEY, null) !== null) GM_deleteValue(TOUR_KEY);
    if (GM_getValue(RESUME_KEY, null) !== null) GM_deleteValue(RESUME_KEY);

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

    // ---------------- Site list (opt-in, with subforum scoping) ----------------
    function getSites() {
        try {
            const o = JSON.parse(GM_getValue(SITES_KEY, 'null'));
            if (!o || typeof o !== 'object') return {};
            const out = {};
            for (const [d, c] of Object.entries(o)) {
                const cfg = c || {};
                out[d] = {
                    all: ('all' in cfg) ? !!cfg.all : true, // pre-0.7 entries were site-wide
                    prefixes: Array.isArray(cfg.prefixes) ? cfg.prefixes.filter(p => typeof p === 'string' && p) : [],
                    pattern: typeof cfg.pattern === 'string' ? cfg.pattern : null,
                    sig: typeof cfg.sig === 'string' ? cfg.sig : null,
                    nextSig: typeof cfg.nextSig === 'string' ? cfg.nextSig : null
                };
            }
            return out;
        } catch (_) { return {}; }
    }
    const saveSites = (s) => GM_setValue(SITES_KEY, JSON.stringify(s));

    const normDomain = (raw) => (raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    const normPrefix = (raw) => (raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');

    function getSiteFor(hostname) {
        const sites = getSites();
        const h = (hostname || '').toLowerCase();
        for (const d of Object.keys(sites)) {
            if (h === d || h.endsWith('.' + d)) return { domain: d, cfg: sites[d] };
        }
        return null;
    }

    // Scope matching: a prefix like "site.com/red-films-vf13" covers that subforum and
    // its pagination ("…-vf13.htm", "…-vf13,25.htm") but not "…-vf139.htm" — after the
    // prefix, the next character must be a separator.
    const SCOPE_BOUNDARY = '/?&#.,';
    const scopeKey = (u) => {
        try {
            const x = new URL(u);
            return (x.host + x.pathname + x.search).toLowerCase().replace(/\/$/, '');
        } catch (_) { return ''; }
    };
    function inScope(cfg, url) {
        if (!cfg) return false;
        if (cfg.all) return true;
        const cur = scopeKey(url);
        return (cfg.prefixes || []).some(p => {
            const pf = normPrefix(p);
            if (!pf || !cur.startsWith(pf)) return false;
            return cur.length === pf.length || SCOPE_BOUNDARY.includes(cur[pf.length]);
        });
    }

    // Suggest a scope prefix for the current page: strip common pagination markers and
    // the file extension so page 1 and page N of a subforum share one prefix
    // (e.g. /red-films-vf13.htm and /red-films-vf13,25.htm → site.com/red-films-vf13).
    function suggestPrefix(u) {
        try {
            const x = new URL(u);
            let path = x.pathname
                .replace(/,\d+(?=\.\w+$)/, '')          // flat-style page suffix: name,25.htm
                .replace(/\.(html?|php|aspx?|cgi)$/i, '')
                .replace(/\/page[-/]?\d+\/?$/i, '')     // /page-2, /page/2
                .replace(/\/$/, '');
            const params = new URLSearchParams(x.search);
            ['page', 'paged', 'start', 'offset', 'p', 'pg'].forEach(k => params.delete(k));
            const q = params.toString();
            return (x.host + path + (q ? '?' + q : '')).toLowerCase();
        } catch (_) { return ''; }
    }

    // ---------------- Detection ----------------
    // Works on either the live document or a fetched-and-parsed one; `base` is that
    // document's own URL so relative hrefs resolve correctly.

    // Every same-site, non-current anchor (no filtering) — used by next-page detection.
    function allAnchors(root, base) {
        let origin;
        try { origin = new URL(base).origin; } catch (_) { return []; }
        const here = norm(base, base);
        const out = [];
        for (const a of root.querySelectorAll('a[href]')) {
            const raw = a.getAttribute('href');
            if (!raw || raw.startsWith('#') || /^(javascript|mailto|tel):/i.test(raw)) continue;
            let u;
            try { u = new URL(raw, base); } catch (_) { continue; }
            if (u.origin !== origin) continue;
            const nurl = norm(u.href, base);
            if (nurl === here) continue;
            out.push({ a, url: nurl, urlObj: u, text: (a.textContent || '').trim() });
        }
        return out;
    }

    // Filtered anchors for topic detection: same-site, not current, not chrome/pagination,
    // has title-ish text. `applyNegative` is skipped for taught detection.
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

    // All same-signature topic anchors on the page, deduped by URL (wordiest text wins).
    function clusterForSig(sig) {
        const recs = collectAnchors(document, location.href, false) || [];
        const byUrl = new Map();
        for (const r of recs) {
            if (signature(r.a, true) !== sig) continue;
            const prev = byUrl.get(r.url);
            if (!prev || r.text.length > prev.text.length) byUrl.set(r.url, r);
        }
        return Array.from(byUrl.values());
    }

    // Taught URL pattern (secondary): match pathname+search against the stored regex.
    // Used when the taught structure isn't found (e.g. raw fetched HTML that differs
    // from the live DOM, or a theme change).
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
            else if (r.text.length > prev.text.length) prev.text = r.text; // keep the wordiest
        }
        const list = Array.from(byUrl.values());
        return list.length ? list : null;
    }

    // Heuristic clustering (bootstrap for un-taught sites). Pass `onlySig` to restrict
    // to a taught structural signature instead of free scoring.
    function detectTopics(root, base, onlySig) {
        base = base || location.href;
        const records = collectAnchors(root, base, !onlySig);
        if (!records) return null;

        if (onlySig) {
            const byUrl = new Map();
            for (const r of records) {
                if (signature(r.a, true) !== onlySig) continue;
                const prev = byUrl.get(r.url);
                if (!prev || r.text.length > prev.text.length) byUrl.set(r.url, { url: r.url, text: r.text });
            }
            const uniq = Array.from(byUrl.values());
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

    // Detection order for an opted-in site: taught page structure → taught URL
    // pattern → generic heuristic.
    function detectForSite(root, base, cfg) {
        if (cfg && cfg.sig) {
            const r = detectTopics(root, base, cfg.sig);
            if (r) return r;
        }
        if (cfg && cfg.pattern) {
            const r = detectByPattern(root, base, cfg.pattern);
            if (r && r.length >= MIN_TAUGHT) return r;
        }
        return detectTopics(root, base);
    }

    // Given a set of anchors, find the "next page" among numeric page-number links.
    // The current page is the smallest page number NOT linked (it's rendered as plain
    // text/active), so next = that number + 1. Naturally yields nothing on the last
    // page. Works regardless of URL shape, including offset schemes where page 1 omits
    // the offset (…vf13.htm) and page 2 adds it (…vf13,25.htm).
    function pickNumericNext(anchors) {
        const byNum = new Map();
        for (const r of anchors) {
            if (!/^\d{1,6}$/.test(r.text)) continue;
            const n = parseInt(r.text, 10);
            if (!n || byNum.has(n)) continue;
            byNum.set(n, r.url);
        }
        if (!byNum.size) return null;
        let current = 1;
        while (byNum.has(current)) current++;
        return byNum.get(current + 1) || null;
    }

    function pickTextNext(anchors) {
        for (const r of anchors) {
            const al = (r.a.getAttribute('aria-label') || '').trim();
            if (NEXT_TEXT.test(r.text) || (/next|older/i.test(al) && !/prev|newer/i.test(al))) return r.url;
        }
        return null;
    }

    // Next-page order: taught pager signature → rel=next → numeric page links →
    // narrowed forward-text/arrow. Always returns a same-site normalized URL or null.
    function detectNextPage(root, base, cfg) {
        base = base || location.href;
        const anchors = allAnchors(root, base);

        if (cfg && cfg.nextSig) {
            const grp = anchors.filter(r => signature(r.a, true) === cfg.nextSig);
            const r = pickNumericNext(grp) || pickTextNext(grp) || (grp.length === 1 ? grp[0].url : null);
            if (r) return r;
        }

        let origin;
        try { origin = new URL(base).origin; } catch (_) { origin = location.origin; }
        const el = root.querySelector('a[rel~="next"], link[rel~="next"]');
        if (el) {
            const raw = el.getAttribute('href');
            if (raw) {
                try {
                    const u = new URL(raw, base);
                    if (u.origin === origin) return norm(u.href, base);
                } catch (_) {}
            }
        }

        return pickNumericNext(anchors) || pickTextNext(anchors);
    }

    // ---------------- Teaching: pattern derivation ----------------
    // Structure-first: learn from the anchor the user clicks (or pastes). A URL pattern
    // is additionally derived from the structural cluster as a fallback for fetched
    // pages / theme changes. The example link itself is never stored.
    const escRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pathSegs = (p) => p.replace(/\/+$/, '').split('/').filter(Boolean);

    // Generalize a set of differing values at one path position into a regex piece:
    // digit runs become \d+, then the longest common prefix/suffix stays literal and
    // the varying middle becomes [^/]*.
    // e.g. ["niski-przelot-vt623031.htm", "chodnikiem-vt623002.htm"] → "[^/]*-vt\d+\.htm"
    function generalizeVals(vals) {
        if (vals.every(v => /^\d+$/.test(v))) return '\\d+';
        const t = vals.map(v => v.replace(/\d+/g, ' '));
        let pre = t[0];
        for (const s of t) {
            let i = 0;
            while (i < pre.length && i < s.length && pre[i] === s[i]) i++;
            pre = pre.slice(0, i);
        }
        let suf = t[0];
        for (const s of t) {
            let i = 0;
            while (i < suf.length && i < s.length && suf[suf.length - 1 - i] === s[s.length - 1 - i]) i++;
            suf = suf.slice(suf.length - i);
        }
        const minLen = Math.min.apply(null, t.map(s => s.length));
        if (pre.length + suf.length > minLen) suf = suf.slice(pre.length + suf.length - minLen);
        const mid = t.every(s => s.length === pre.length + suf.length) ? '' : '[^/]*';
        const conv = (s) => s.split(' ').map(escRx).join('\\d+');
        return conv(pre) + mid + conv(suf);
    }

    function deriveFromUrls(urls) {
        const segLists = urls.map(u => pathSegs(u.pathname));
        const depth = segLists[0].length;
        if (!depth || !segLists.every(s => s.length === depth)) return null;
        const parts = [];
        for (let i = 0; i < depth; i++) {
            const vals = Array.from(new Set(segLists.map(s => s[i])));
            parts.push(vals.length === 1 ? escRx(vals[0]) : generalizeVals(vals));
        }
        let src = '^/' + parts.join('/');
        const searches = urls.map(u => u.search);
        if (searches.every(s => s)) src += escRx(searches[0]).replace(/\d+/g, '\\d+');
        return src;
    }

    // Paste-fallback analysis: locate the pasted link on the page, learn its structure.
    function analyzeExample(exampleRaw) {
        let exUrl;
        try { exUrl = new URL(norm((exampleRaw || '').trim())); } catch (_) {
            return { error: 'That does not look like a valid link.' };
        }
        if (exUrl.origin !== location.origin) {
            return { error: 'That link is on a different site (' + exUrl.hostname + ') — open that forum first.' };
        }
        const ex = norm(exUrl.href);
        const records = collectAnchors(document, location.href, false) || [];
        const matches = records.filter(r => r.url === ex);
        if (!matches.length) {
            const rawPresent = Array.from(document.querySelectorAll('a[href]')).some(a => {
                try { return norm(new URL(a.getAttribute('href'), location.href).href) === ex; } catch (_) { return false; }
            });
            return {
                error: rawPresent
                    ? 'That link is filtered out as site navigation/pagination here — paste a topic-title link instead.'
                    : 'That link is not on this page — open the index page that lists it, then teach.'
            };
        }
        const example = matches.reduce((p, c) => (c.text.length >= p.text.length ? c : p));
        const sig = signature(example.a, true);
        const cluster = clusterForSig(sig);
        const pattern = cluster.length >= 3 ? deriveFromUrls(cluster.map(r => r.urlObj)) : null;
        return { sig, pattern, count: cluster.length };
    }

    // ---------------- Teaching: guided click-to-pick ----------------
    let captureState = null;   // { domain, step: 'topic' | 'next' }
    let captureBanner = null;
    let hoverEl = null;

    function showCaptureBanner() {
        captureBanner = document.createElement('div');
        captureBanner.id = 'fs-teach-banner';
        captureBanner.style.cssText = 'all: initial;';
        const root = captureBanner.attachShadow({ mode: 'open' });
        const st = document.createElement('style');
        st.textContent = ':host { all: initial; } * { box-sizing: border-box; }';
        root.appendChild(st);
        const wrap = document.createElement('div');
        wrap.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
            display: flex; align-items: center; justify-content: center; gap: 14px;
            padding: 11px 16px; background: #1e1e2e; color: #cdd6f4;
            font: 14px/1.35 system-ui, sans-serif; box-shadow: 0 2px 14px rgba(0,0,0,0.45);
        `;
        const msg = document.createElement('span');
        msg.style.cssText = 'font-weight: 600; text-align: center;';
        const cancel = document.createElement('button');
        cancel.textContent = 'Cancel';
        cancel.style.cssText = 'padding: 5px 14px; border: none; border-radius: 6px; background: #45475a; color: #cdd6f4; font-weight: 700; font-size: 13px; cursor: pointer; flex-shrink: 0;';
        cancel.addEventListener('click', exitCapture);
        wrap.append(msg, cancel);
        root.appendChild(wrap);
        document.documentElement.appendChild(captureBanner);
        captureBanner._msg = msg;
    }
    function setBanner(text, color) {
        if (captureBanner && captureBanner._msg) {
            captureBanner._msg.textContent = text;
            captureBanner._msg.style.color = color || '#cdd6f4';
        }
    }

    function onCaptureMove(e) {
        const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (hoverEl && hoverEl !== a) { hoverEl.style.outline = hoverEl._fsOldOutline || ''; hoverEl = null; }
        if (a && a !== hoverEl) {
            hoverEl = a;
            a._fsOldOutline = a.style.outline;
            a.style.outline = '2px solid #89b4fa';
            a.style.outlineOffset = '1px';
        }
    }
    function onCaptureKey(e) { if (e.key === 'Escape') exitCapture(); }
    function onCaptureClick(e) {
        if (!captureState) return;
        const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (!a) return;                 // let non-link clicks (e.g. the banner) pass
        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        handleCapturePick(a);
    }

    function enterCapture(domain) {
        captureState = { domain, step: 'topic' };
        showCaptureBanner();
        setBanner('Click the first thread / topic link in the list.  (Esc to cancel)');
        document.addEventListener('click', onCaptureClick, true);
        document.addEventListener('mouseover', onCaptureMove, true);
        document.addEventListener('keydown', onCaptureKey, true);
        try { document.body.style.cursor = 'crosshair'; } catch (_) {}
    }
    function exitCapture() {
        document.removeEventListener('click', onCaptureClick, true);
        document.removeEventListener('mouseover', onCaptureMove, true);
        document.removeEventListener('keydown', onCaptureKey, true);
        if (hoverEl) { hoverEl.style.outline = hoverEl._fsOldOutline || ''; hoverEl = null; }
        try { document.body.style.cursor = ''; } catch (_) {}
        if (captureBanner) { captureBanner.remove(); captureBanner = null; }
        captureState = null;
    }
    function finishCaptureSoon() {
        setTimeout(() => { exitCapture(); rescan(); }, 1600);
    }

    function handleCapturePick(a) {
        const sites = getSites();
        const cfg = sites[captureState.domain];
        if (!cfg) { exitCapture(); return; }

        if (captureState.step === 'topic') {
            const sig = signature(a, true);
            const cluster = clusterForSig(sig);
            cfg.sig = sig;
            cfg.pattern = cluster.length >= 3 ? deriveFromUrls(cluster.map(r => r.urlObj)) : null;
            saveSites(sites);
            setBanner('Got it — found ' + cluster.length + ' topic' + (cluster.length === 1 ? '' : 's') +
                ' with that structure. Looking for the “next page” link…');
            const nxt = detectNextPage(document, location.href, {}); // auto-detect only
            if (nxt) {
                setBanner('✓ Learned the topic links and found the “Next” link automatically. All set!', '#a6e3a1');
                finishCaptureSoon();
            } else {
                captureState.step = 'next';
                setBanner('Couldn’t find the “next page” link. Now click the link to page 2 of this list (or Cancel if there is none).');
            }
        } else {
            cfg.nextSig = signature(a, true);
            saveSites(sites);
            setBanner('✓ Learned the next-page link. All set!', '#a6e3a1');
            finishCaptureSoon();
        }
    }

    function startGuidedTeach(domain) { enterCapture(domain); }

    // ---------------- UI: floating bar ----------------
    let bar;
    let liveObserver = null;   // updates the topic count on a list page as content lazy-loads
    let waitObserver = null;   // waits for a list to render, then shows the pill

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
            const cfg = site ? site.cfg : null;
            const topics = detectForSite(doc, target, cfg);
            if (!topics) throw new Error('no topics in fetched page');
            const newNext = detectNextPage(doc, target, cfg);
            const first = appendPage(tour, topics, newNext, target);
            if (!first) throw new Error('all duplicates');
            go(first);
        } catch (_) {
            // Fallback: navigate to the next page visibly, then auto-append on load.
            setResume('append');
            go(target);
        }
    }

    // ---------------- Render ----------------
    function render() {
        const tour = loadTour();
        const here = norm(location.href);

        // A running tour owns its pages regardless of scan scope: it was started from
        // an allowed index page, lives only in this tab, and dies with it.
        if (tour && tour.urls) {
            let idx = tour.urls.indexOf(here);
            // Forums may redirect a stored topic URL deeper — Discourse sends logged-in
            // users to the last-read post (/t/slug/123 → /t/slug/123/4). Fall back to a
            // prefix match with a separator so /topic/12 can't claim /topic/123.
            if (idx === -1) idx = tour.urls.findIndex(u => here.startsWith(u + '/') || here.startsWith(u + '?'));
            if (idx !== -1) { renderTourBar(tour, idx); return; }
        }

        // Not in a tour here. Scanning (and the Start pill) only happens inside the
        // designated scope: an opted-in site, on an allowed subforum prefix (or
        // anywhere on it when "whole site" is ticked).
        const site = getSiteFor(location.hostname);
        if (!site || !inScope(site.cfg, location.href)) return;
        renderListPage(site, tour);
    }

    function renderTourBar(tour, idx) {
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
    }

    function renderListPage(site, tour) {
        const topics = detectForSite(document, location.href, site.cfg) || [];
        const resume = getResume();

        if (topics.length) {
            const nextPage = detectNextPage(document, location.href, site.cfg);
            // Arrived here as the fallback continuation of a running tour: append + jump in.
            if (resume === 'append' && tour && tour.urls) {
                delResume();
                const first = appendPage(tour, topics, nextPage, location.href);
                if (first) { go(first); return; }
            }
            if (resume) delResume();
            buildStartPill(site);
        } else {
            if (resume) delResume();
            startWaitObserver(site, tour);
        }
    }

    // The capture pill: a live topic count (updates as lazy-loaded lists grow), a manual
    // Re-scan button, Start, and Hide.
    function buildStartPill(site) {
        if (waitObserver) { waitObserver.disconnect(); waitObserver = null; }
        buildBar(); clearBar();

        const row = mkRow();
        const start = mkBtn('📑 … — Start', 'Capture these topics and open the first');
        const rescanBtn = mkBtn('🔄', 'Re-scan this page for more links (after scrolling)');
        const hide = mkBtn('✕', 'Hide');
        const latest = { topics: [], next: null };

        const recompute = () => {
            latest.topics = detectForSite(document, location.href, site.cfg) || [];
            latest.next = detectNextPage(document, location.href, site.cfg);
            const n = latest.topics.length;
            start.textContent = `📑 ${n} topic${n === 1 ? '' : 's'} — Start`;
            start.style.opacity = n ? '1' : '0.5';
            start.style.cursor = n ? 'pointer' : 'default';
        };
        recompute();

        start.addEventListener('click', () => { if (latest.topics.length) startTour(latest.topics, latest.next); });
        rescanBtn.addEventListener('click', recompute);
        hide.addEventListener('click', () => {
            if (liveObserver) { liveObserver.disconnect(); liveObserver = null; }
            bar.remove();
        });

        row.append(start, rescanBtn, hide);
        bar.append(row);

        // Live recount, event-driven (only fires when the DOM actually changes), throttled.
        if (liveObserver) liveObserver.disconnect();
        let t = null;
        liveObserver = new MutationObserver(() => {
            if (t) clearTimeout(t);
            t = setTimeout(recompute, 700);
        });
        if (document.body) liveObserver.observe(document.body, { childList: true, subtree: true });
    }

    // No list yet (slow SPA render). Watch for DOM changes and try again; show the pill
    // once a list appears. Gives up after 15s.
    function startWaitObserver(site, tour) {
        if (waitObserver || bar) return;
        let t = null;
        waitObserver = new MutationObserver(() => {
            if (t) clearTimeout(t);
            t = setTimeout(() => { if (!bar) renderListPage(site, tour); }, 500);
        });
        if (document.body) waitObserver.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { if (waitObserver) { waitObserver.disconnect(); waitObserver = null; } }, 15000);
    }

    function rescan() {
        if (liveObserver) { liveObserver.disconnect(); liveObserver = null; }
        if (waitObserver) { waitObserver.disconnect(); waitObserver = null; }
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
            padding: 20px 24px; width: 520px; max-height: 85vh;
            display: flex; flex-direction: column; gap: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5); overflow: hidden;
        `;

        const title = document.createElement('div');
        title.style.cssText = 'font-size: 15px; font-weight: 700; color: #89b4fa;';
        title.textContent = 'Forum Stumbler — Settings';

        const desc = document.createElement('div');
        desc.style.cssText = 'font-size: 12px; color: #9399b2; line-height: 1.45;';
        const descMain = document.createElement('div');
        descMain.textContent = 'Forum Stumbler only scans the sites listed here (opt-in). By default a site is scoped to the subforum pages you add; tick "whole site" to scan everywhere on it.';
        const descTeach = document.createElement('div');
        descTeach.style.cssText = 'margin-top: 4px; color: #6c7086; font-style: italic;';
        descTeach.textContent = 'To teach a site: open a subforum page, click Teach → "Pick on page", then click a topic link (and page 2 if asked). Nothing about the links is stored except the structure template.';
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
        addCurrentBtn.title = 'Add the current site (' + location.hostname + '), scoped to the current page';
        addRow.append(input, addBtn, addCurrentBtn);

        // Site list
        const list = document.createElement('div');
        list.style.cssText = `
            overflow-y: auto; display: flex; flex-direction: column; gap: 6px;
            flex: 1; min-height: 0; max-height: 45vh; padding-right: 4px;
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
            lbl.style.cssText = 'font-size: 12px; color: #cdd6f4; font-weight: 600;';
            lbl.textContent = 'Teach ' + domain;

            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display: flex; gap: 6px; align-items: center;';
            const pickBtn = smallBtn('Pick on page', '#89b4fa');
            pickBtn.title = 'Close settings, then click a topic link on the page (guided)';
            pickBtn.addEventListener('click', () => { host.remove(); startGuidedTeach(domain); });
            const pasteToggle = smallBtn('Paste a link instead', '#45475a', '#cdd6f4');
            const cancelBtn = smallBtn('Cancel', '#45475a', '#cdd6f4');
            cancelBtn.addEventListener('click', hideTeach);
            btnRow.append(pickBtn, pasteToggle, cancelBtn);

            // Paste fallback (topic structure only)
            const pasteWrap = document.createElement('div');
            pasteWrap.style.cssText = 'display: none; flex-direction: column; gap: 6px;';
            const pasteRow = document.createElement('div');
            pasteRow.style.cssText = 'display: flex; gap: 6px;';
            const tInput = document.createElement('input');
            tInput.type = 'text';
            tInput.placeholder = 'Paste a topic link from the current page…';
            tInput.style.cssText = input.style.cssText;
            const analyzeBtn = smallBtn('Analyze', '#89b4fa');
            pasteRow.append(tInput, analyzeBtn);
            const result = document.createElement('div');
            result.style.cssText = 'font-size: 12px; line-height: 1.4; word-break: break-all;';
            const saveRow = document.createElement('div');
            saveRow.style.cssText = 'display: none; gap: 6px;';
            pasteWrap.append(pasteRow, result, saveRow);

            pasteToggle.addEventListener('click', () => {
                pasteWrap.style.display = pasteWrap.style.display === 'none' ? 'flex' : 'none';
                if (pasteWrap.style.display === 'flex') tInput.focus();
            });

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
                result.textContent = 'Found ' + res.count + ' link' + (res.count === 1 ? '' : 's') +
                    ' sharing this page structure.' +
                    (res.count < MIN_TAUGHT ? ' That looks too few — try a different link, or Save anyway.' : '');
                const saveBtn = smallBtn('Save', '#a6e3a1');
                saveBtn.addEventListener('click', () => {
                    const sites = getSites();
                    if (sites[domain]) {
                        sites[domain].sig = res.sig;
                        sites[domain].pattern = res.pattern;
                        saveSites(sites);
                    }
                    hideTeach();
                    renderList();
                    flashStatus('Saved topic structure for ' + domain + '.');
                });
                saveRow.appendChild(saveBtn);
                saveRow.style.display = 'flex';
            }
            analyzeBtn.addEventListener('click', analyze);
            tInput.addEventListener('keydown', e => { if (e.key === 'Enter') analyze(); });

            teachArea.append(lbl, btnRow, pasteWrap);
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
                const cfg = sites[d];
                const onSite = h === d || h.endsWith('.' + d);
                const taught = !!(cfg.sig || cfg.pattern);

                const wrap = document.createElement('div');
                wrap.style.cssText = 'display: flex; flex-direction: column; gap: 5px; background: #313244; border-radius: 6px; padding: 7px 10px;';

                const row = document.createElement('div');
                row.style.cssText = 'display: flex; align-items: center; gap: 6px;';
                const label = document.createElement('span');
                label.style.cssText = 'font-size: 13px; word-break: break-all; flex: 1; font-weight: 600;';
                label.textContent = d;
                row.appendChild(label);

                if (taught) {
                    const badge = document.createElement('span');
                    badge.style.cssText = 'font-size: 11px; color: #a6e3a1; flex-shrink: 0;';
                    badge.textContent = cfg.nextSig ? 'taught +next' : 'taught';
                    badge.title = 'Structure: ' + (cfg.sig || '(none)') +
                        (cfg.pattern ? '\nURL pattern: ' + cfg.pattern : '') +
                        (cfg.nextSig ? '\nNext-page: ' + cfg.nextSig : '');
                    row.appendChild(badge);
                }

                // "whole site" toggle
                const allLbl = document.createElement('label');
                allLbl.style.cssText = 'display: flex; align-items: center; gap: 4px; font-size: 12px; color: #9399b2; cursor: pointer; flex-shrink: 0;';
                const allCb = document.createElement('input');
                allCb.type = 'checkbox';
                allCb.checked = !!cfg.all;
                allCb.style.cssText = 'accent-color: #89b4fa; cursor: pointer;';
                const allTxt = document.createElement('span');
                allTxt.textContent = 'whole site';
                allLbl.title = 'Scan everywhere on this site instead of only the listed pages';
                allLbl.append(allCb, allTxt);
                allCb.addEventListener('change', () => {
                    const s = getSites();
                    if (s[d]) { s[d].all = allCb.checked; saveSites(s); }
                    renderList();
                });
                row.appendChild(allLbl);

                const teachBtn = smallBtn(taught ? 'Re-teach' : 'Teach', '#89b4fa');
                if (onSite) {
                    teachBtn.title = 'Learn the topic-link structure from this page';
                    teachBtn.addEventListener('click', () => showTeach(d));
                } else {
                    teachBtn.style.opacity = '0.4';
                    teachBtn.style.cursor = 'default';
                    teachBtn.title = 'Open a subforum page on ' + d + ' to teach it';
                }
                row.appendChild(teachBtn);

                if (taught || cfg.nextSig) {
                    const forgetBtn = smallBtn('Forget', '#f9e2af');
                    forgetBtn.title = 'Forget the taught structure (falls back to auto-detection)';
                    forgetBtn.addEventListener('click', () => {
                        const s = getSites();
                        if (s[d]) { s[d].sig = null; s[d].pattern = null; s[d].nextSig = null; saveSites(s); }
                        renderList();
                        flashStatus('Forgot taught structure for ' + d + '.');
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
                wrap.appendChild(row);

                // Scoped: list the allowed page prefixes + an add row
                if (!cfg.all) {
                    cfg.prefixes.forEach((p, i) => {
                        const pRow = document.createElement('div');
                        pRow.style.cssText = 'display: flex; align-items: center; gap: 6px; padding-left: 12px;';
                        const pLabel = document.createElement('span');
                        pLabel.style.cssText = 'font-size: 12px; color: #9399b2; word-break: break-all; flex: 1;';
                        pLabel.textContent = p;
                        const pRemove = document.createElement('button');
                        pRemove.textContent = '✕';
                        pRemove.style.cssText = 'background: none; border: none; color: #f38ba8; cursor: pointer; font-size: 12px; padding: 0 4px; flex-shrink: 0;';
                        pRemove.title = 'Remove this page prefix';
                        pRemove.addEventListener('click', () => {
                            const s = getSites();
                            if (s[d]) { s[d].prefixes = s[d].prefixes.filter((_, j) => j !== i); saveSites(s); }
                            renderList();
                        });
                        pRow.append(pLabel, pRemove);
                        wrap.appendChild(pRow);
                    });

                    if (!cfg.prefixes.length) {
                        const note = document.createElement('div');
                        note.style.cssText = 'font-size: 11px; color: #f9e2af; padding-left: 12px;';
                        note.textContent = 'Inactive — add a page below or tick "whole site".';
                        wrap.appendChild(note);
                    }

                    const pAddRow = document.createElement('div');
                    pAddRow.style.cssText = 'display: flex; gap: 6px; padding-left: 12px;';
                    const pInput = document.createElement('input');
                    pInput.type = 'text';
                    pInput.placeholder = 'e.g. ' + d + '/some-subforum';
                    pInput.style.cssText = input.style.cssText + 'font-size: 12px; padding: 4px 8px;';
                    const pAddBtn = smallBtn('Add', '#89b4fa');
                    const pCurBtn = smallBtn('This Page', '#a6e3a1');
                    pCurBtn.title = onSite
                        ? 'Fill in the current page (pagination markers stripped) — review, then Add'
                        : 'Open a page on ' + d + ' first';
                    if (onSite) {
                        pCurBtn.addEventListener('click', () => { pInput.value = suggestPrefix(location.href); pInput.focus(); });
                    } else {
                        pCurBtn.style.opacity = '0.4';
                        pCurBtn.style.cursor = 'default';
                    }
                    const addPrefix = () => {
                        const pf = normPrefix(pInput.value);
                        if (!pf) return;
                        const s = getSites();
                        if (!s[d]) return;
                        if (s[d].prefixes.includes(pf)) { flashStatus('Already listed.', '#f9e2af'); return; }
                        s[d].prefixes.push(pf);
                        saveSites(s);
                        renderList();
                    };
                    pAddBtn.addEventListener('click', addPrefix);
                    pInput.addEventListener('keydown', e => { if (e.key === 'Enter') addPrefix(); });
                    pAddRow.append(pInput, pAddBtn, pCurBtn);
                    wrap.appendChild(pAddRow);
                }

                list.appendChild(wrap);
            });
        }

        function addSite(raw, fromCurrentPage) {
            const d = normDomain(raw);
            if (!d) return;
            const sites = getSites();
            if (sites[d]) { flashStatus('Already listed.', '#f9e2af'); return; }
            const prefixes = [];
            if (fromCurrentPage) {
                const pf = suggestPrefix(location.href);
                if (pf) prefixes.push(pf);
            }
            sites[d] = { all: false, prefixes, pattern: null, sig: null, nextSig: null };
            saveSites(sites);
            renderList();
            input.value = '';
            flashStatus(fromCurrentPage && prefixes.length
                ? 'Added ' + d + ', scoped to ' + prefixes[0]
                : 'Added ' + d + ' — now add a page prefix or tick "whole site".');
        }

        addBtn.addEventListener('click', () => addSite(input.value, false));
        input.addEventListener('keydown', e => { if (e.key === 'Enter') addSite(input.value, false); });
        addCurrentBtn.addEventListener('click', () => addSite(location.hostname, true));

        // Import / Export (whole config: sites, scopes, taught structures, as JSON)
        const ioRow = document.createElement('div');
        ioRow.style.cssText = 'display: flex; gap: 6px; align-items: center;';
        const exportBtn = smallBtn('Export', '#fab387');
        exportBtn.title = 'Download the site list (with scopes and taught structures) as a .json file';
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
                    for (const [dRaw, cfg] of Object.entries(incoming)) {
                        const dom = normDomain(String(dRaw));
                        if (!dom) continue;
                        sites[dom] = {
                            all: (cfg && 'all' in cfg) ? !!cfg.all : true, // legacy entries were site-wide
                            prefixes: (cfg && Array.isArray(cfg.prefixes)) ? cfg.prefixes.filter(p => typeof p === 'string' && p) : [],
                            pattern: (cfg && typeof cfg.pattern === 'string') ? cfg.pattern : null,
                            sig: (cfg && typeof cfg.sig === 'string') ? cfg.sig : null,
                            nextSig: (cfg && typeof cfg.nextSig === 'string') ? cfg.nextSig : null
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
        const closeAll = () => { host.remove(); rescan(); }; // re-scan so a just-added scope lights up immediately
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
    GM_registerMenuCommand('Forum Stumbler: clear this tab’s tour', () => {
        clearTourState();
        if (bar) { bar.remove(); bar = null; }
    });

    // ---------------- Boot ----------------
    // render() shows the tour bar or the capture pill; if a list hasn't rendered yet on
    // an in-scope page, renderListPage installs a MutationObserver to wait for it.
    render();
})();
