// ==UserScript==
// @name        Forum Stumbler
// @namespace   https://github.com/VitaKaninen
// @version     0.15.0
// @author      VitaKaninen
// @description Capture every topic link on a forum index page, then walk them with Back/Next buttons — no tabs. Opt-in per site, guided click-to-teach with highlight-and-verify plus exception rules, accumulating capture for infinite scroll.
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
    const PENDING_KEY = 'fs_pending';     // sessionStorage: index we just navigated to (survives site URL rewrites)
    const POS_KEY = 'fs_barpos';          // GM: { right, bottom }
    const SITES_KEY = 'fs_sites';         // GM: { "<host>": { all, prefixes[], pattern, sig, nextSig, exclude[] } }
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

    // Forward-pagination vocabulary — deliberately narrow: only things that mean
    // "the next page of this list". "previous"/"newer"/back-arrows are excluded so we
    // never walk backwards.
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
        try {
            sessionStorage.removeItem(TOUR_KEY);
            sessionStorage.removeItem(RESUME_KEY);
            sessionStorage.removeItem(PENDING_KEY);
        } catch (_) {}
    };
    const getResume = () => { try { return sessionStorage.getItem(RESUME_KEY) || ''; } catch (_) { return ''; } };
    const setResume = (v) => { try { sessionStorage.setItem(RESUME_KEY, v); } catch (_) {} };
    const delResume = () => { try { sessionStorage.removeItem(RESUME_KEY); } catch (_) {} };
    const setPending = (i) => { try { sessionStorage.setItem(PENDING_KEY, String(i)); } catch (_) {} };
    const takePending = () => {
        try {
            const v = sessionStorage.getItem(PENDING_KEY);
            if (v === null) return null;
            sessionStorage.removeItem(PENDING_KEY);
            const n = parseInt(v, 10);
            return Number.isInteger(n) ? n : null;
        } catch (_) { return null; }
    };
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

    // Deep structural chain for exception matching: anchor-outward, up to 8 ancestors,
    // ALL classes per level (digit-normalized, sorted for stability). Exceptions store
    // the shortest prefix of this chain that discriminates, so deeper per-row variation
    // (read/unread state classes on ancestors) doesn't break the match.
    function sigDeep(a) {
        const parts = [];
        let el = a;
        for (let i = 0; i < 8 && el && el.tagName && !/^(BODY|HTML)$/i.test(el.tagName); i++) {
            let sig = el.tagName.toLowerCase();
            const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean)
                .map(c => c.replace(/\d+/g, '#')).sort().join('.');
            if (cls) sig += '.' + cls;
            parts.push(sig);
            el = el.parentElement;
        }
        return parts.join('>');
    }
    const sigDeepMatches = (chain, prefix) => chain === prefix || chain.startsWith(prefix + '>');
    function excludedBySig(a, prefixes) {
        if (!prefixes || !prefixes.length) return false;
        const c = sigDeep(a);
        return prefixes.some(p => sigDeepMatches(c, p));
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
                    nextSig: typeof cfg.nextSig === 'string' ? cfg.nextSig : null,
                    exclude: Array.isArray(cfg.exclude) ? cfg.exclude.filter(p => typeof p === 'string' && p) : [],
                    excludeSigs: Array.isArray(cfg.excludeSigs) ? cfg.excludeSigs.filter(p => typeof p === 'string' && p) : [],
                    goodSigs: Array.isArray(cfg.goodSigs) ? cfg.goodSigs.filter(p => typeof p === 'string' && p) : [],
                    // Pager exceptions: same shape as the thread ones, applied to the
                    // taught next-link group instead.
                    nextExclude: Array.isArray(cfg.nextExclude) ? cfg.nextExclude.filter(p => typeof p === 'string' && p) : [],
                    nextExcludeSigs: Array.isArray(cfg.nextExcludeSigs) ? cfg.nextExcludeSigs.filter(p => typeof p === 'string' && p) : [],
                    nextGoodSigs: Array.isArray(cfg.nextGoodSigs) ? cfg.nextGoodSigs.filter(p => typeof p === 'string' && p) : []
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

    // All same-signature topic anchors on the live page, deduped by URL (wordiest wins).
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

    // Exception rules: regexes over pathname+search that carve wrong links (subforums,
    // sub-subforums) out of an otherwise broad include rule.
    function compileExcludes(list) {
        const out = [];
        for (const p of (list || [])) { try { out.push(new RegExp(p, 'i')); } catch (_) {} }
        return out;
    }
    const excludedByRx = (urlObj, rxs) => rxs.some(rx => rx.test(urlObj.pathname + urlObj.search));
    function filterExcluded(list, rxs) {
        if (!list || !rxs.length) return list;
        const out = list.filter(t => {
            try { return !excludedByRx(new URL(t.url), rxs); } catch (_) { return true; }
        });
        return out.length ? out : null;
    }

    // Taught URL pattern (secondary): match pathname+search against the stored regex.
    // Used when the taught structure isn't found (e.g. raw fetched HTML that differs
    // from the live DOM, or a theme change).
    function detectByPattern(root, base, patternSrc, exSigs) {
        let rx;
        try { rx = new RegExp(patternSrc, 'i'); } catch (_) { return null; }
        base = base || location.href;
        const records = collectAnchors(root, base, false);
        if (!records) return null;
        const byUrl = new Map();
        for (const r of records) {
            if (!rx.test(r.urlObj.pathname + r.urlObj.search)) continue;
            if (excludedBySig(r.a, exSigs)) continue;
            const prev = byUrl.get(r.url);
            if (!prev) byUrl.set(r.url, { url: r.url, text: r.text });
            else if (r.text.length > prev.text.length) prev.text = r.text; // keep the wordiest
        }
        const list = Array.from(byUrl.values());
        return list.length ? list : null;
    }

    // Heuristic clustering (bootstrap for un-taught sites). Pass `onlySig` to restrict
    // to a taught structural signature instead of free scoring.
    function detectTopics(root, base, onlySig, exSigs) {
        base = base || location.href;
        const records = collectAnchors(root, base, !onlySig);
        if (!records) return null;

        if (onlySig) {
            const byUrl = new Map();
            for (const r of records) {
                if (signature(r.a, true) !== onlySig) continue;
                if (excludedBySig(r.a, exSigs)) continue;
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

    // Detection for an opted-in site. A taught site uses ONLY its taught rules
    // (minus exceptions): on pages where they match nothing (thread pages, subforum
    // listings) the script stays quiet instead of guessing. Structure and URL
    // pattern are UNIONED, not tried in order: infinite-scroll sites (Reddit)
    // render later batches with different markup, so the structure catches one
    // layout and the URL pattern catches the rest. Un-taught sites use the heuristic.
    function detectForSite(root, base, cfg) {
        if (cfg && (cfg.sig || cfg.pattern)) {
            const rxs = compileExcludes(cfg.exclude);
            const exSigs = (cfg.excludeSigs && cfg.excludeSigs.length) ? cfg.excludeSigs : null;
            const byUrl = new Map();
            const lists = [
                cfg.sig ? detectTopics(root, base, cfg.sig, exSigs) : null,
                cfg.pattern ? detectByPattern(root, base, cfg.pattern, exSigs) : null
            ];
            for (const list of lists) {
                for (const t of (list || [])) if (!byUrl.has(t.url)) byUrl.set(t.url, t);
            }
            const merged = filterExcluded(Array.from(byUrl.values()), rxs);
            return (merged && merged.length >= MIN_TAUGHT) ? merged : null;
        }
        return detectTopics(root, base);
    }

    // Given a set of anchors, find the "next page" among numeric page-number links.
    // The current page is the smallest page number NOT linked (it's rendered as plain
    // text/active), so next = that number + 1. Naturally yields nothing on the last
    // page. Works regardless of URL shape, including offset schemes where page 1 omits
    // the offset (…vf13.htm) and page 2 adds it (…vf13,25.htm).
    // The pickers return the whole record ({ a, url, … }) rather than just the URL so
    // the debug drawer can highlight the very anchor the tour will follow.
    function pickNumericNext(anchors) {
        const byNum = new Map();
        for (const r of anchors) {
            if (!/^\d{1,6}$/.test(r.text)) continue;
            const n = parseInt(r.text, 10);
            if (!n || byNum.has(n)) continue;
            byNum.set(n, r);
        }
        if (!byNum.size) return null;
        let current = 1;
        while (byNum.has(current)) current++;
        return byNum.get(current + 1) || null;
    }

    // Un-taught bootstrap: which same-position group of numeric links is actually a
    // pager? Per-post metadata counts ("💬 8", "3 replies") are numeric links too, so
    // a bare "smallest unlinked number" scan over the whole page picks nonsense.
    // A real page list starts at 1 or 2 and runs consecutively.
    function pickPagerGroup(anchors) {
        const groups = new Map();
        for (const r of anchors) {
            if (!/^\d{1,6}$/.test(r.text)) continue;
            const sig = signature(r.a, true);
            if (!groups.has(sig)) groups.set(sig, []);
            groups.get(sig).push(r);
        }
        let best = null;
        for (const items of groups.values()) {
            const nums = Array.from(new Set(items.map(r => parseInt(r.text, 10)))).sort((a, b) => a - b);
            if (nums.length < 2 || nums[0] > 2) continue;
            let run = 1;
            while (run < nums.length && nums[run] === nums[run - 1] + 1) run++;
            if (run < 2) continue;
            if (!best || run > best.run) best = { items, run };
        }
        return best ? best.items : [];
    }

    function pickTextNext(anchors) {
        for (const r of anchors) {
            const al = (r.a.getAttribute('aria-label') || '').trim();
            if (NEXT_TEXT.test(r.text) || (/next|older/i.test(al) && !/prev|newer/i.test(al))) return r;
        }
        return null;
    }

    // Next-page order: taught pager signature → rel=next → numeric page links →
    // narrowed forward-text/arrow. Returns { url, a, how } or null; `how` names the
    // rule that fired (shown in the debug drawer) and `a` may be null for a
    // <link rel=next> in the head.
    function detectNextRecord(root, base, cfg) {
        base = base || location.href;
        const anchors = allAnchors(root, base);

        // A taught pager is authoritative: no falling back to the heuristics below.
        // Falling through is what let a per-post comment-count link ("💬 8" — a bare
        // number, so it looks like a page link) become the next page. An empty group
        // means "last page", which must yield null, not a guess.
        if (cfg && cfg.nextSig) {
            const exRx = compileExcludes(cfg.nextExclude);
            const grp = anchors.filter(r => signature(r.a, true) === cfg.nextSig &&
                !excludedBySig(r.a, cfg.nextExcludeSigs) && !excludedByRx(r.urlObj, exRx));
            const r = pickNumericNext(grp) || pickTextNext(grp) || (grp.length === 1 ? grp[0] : null);
            return r ? { url: r.url, a: r.a, how: 'taught pager link' } : null;
        }

        let origin;
        try { origin = new URL(base).origin; } catch (_) { origin = location.origin; }
        const el = root.querySelector('a[rel~="next"], link[rel~="next"]');
        if (el) {
            const raw = el.getAttribute('href');
            if (raw) {
                try {
                    const u = new URL(raw, base);
                    if (u.origin === origin) {
                        return { url: norm(u.href, base), a: /^a$/i.test(el.tagName) ? el : null, how: 'rel="next"' };
                    }
                } catch (_) {}
            }
        }

        const num = pickNumericNext(pickPagerGroup(anchors));
        if (num) return { url: num.url, a: num.a, how: 'numeric page link' };
        const txt = pickTextNext(anchors);
        if (txt) return { url: txt.url, a: txt.a, how: 'next/older text link' };
        return null;
    }

    function detectNextPage(root, base, cfg) {
        const r = detectNextRecord(root, base, cfg);
        return r ? r.url : null;
    }

    // ---------------- Teaching: pattern derivation ----------------
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
        // Mixed path depths: derive from the dominant depth when it clearly dominates
        // (a stray odd link among many uniform ones), else give up.
        const byDepth = new Map();
        for (const u of urls) {
            const d = pathSegs(u.pathname).length;
            if (!byDepth.has(d)) byDepth.set(d, []);
            byDepth.get(d).push(u);
        }
        let major = null;
        for (const g of byDepth.values()) if (!major || g.length > major.length) major = g;
        if (byDepth.size > 1) {
            if (major.length < 3 || major.length * 2 < urls.length) return null;
            urls = major;
        }
        const segLists = urls.map(u => pathSegs(u.pathname));
        const depth = segLists[0].length;
        if (!depth) return null;
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

    // One URL with its digits generalized — the narrowest useful exception rule.
    const digitGen = (u) => '^' + escRx(u.pathname).replace(/\d+/g, '\\d+') +
        (u.search ? escRx(u.search).replace(/\d+/g, '\\d+') : '');

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
            return { error: 'That link is not on this page (or is filtered as navigation) — paste a topic-title link that appears here.' };
        }
        const example = matches.reduce((p, c) => (c.text.length >= p.text.length ? c : p));
        const sig = signature(example.a, true);
        const cluster = clusterForSig(sig);
        const pattern = cluster.length >= 3 ? deriveFromUrls(cluster.map(r => r.urlObj)) : null;
        return { sig, pattern, count: cluster.length };
    }

    // ---------------- Teaching: guided click-to-pick ----------------
    // Guided flows, each a centered draggable popup with click capture:
    //  - Teach threads ('full'): wipes the site's taught rules, then walks the whole
    //    setup in one pass — pick the first thread link → verify the highlighted
    //    matches (with an inline "Fix wrong links" detour) → confirm or click the
    //    next-page link → verify the pager and exclude anything in it that isn't a
    //    page number. Esc/Cancel exits with the rules left wiped.
    //  - Exceptions ('except'): runs on any page, no wipe, thread links only.
    //    Highlights what the saved rule catches there; each click on a wrong link
    //    becomes a structural (position) rule when the markup discriminates against
    //    the stored good chains, else a URL-shape rule. Save APPENDS to the stored
    //    rules. Esc/Cancel changes nothing.
    //  - Next link ('nextonly'): the pager half of the full flow on its own, for
    //    checking/correcting "next page" from the bar's debug drawer.
    //
    // Thread links and the pager are taught with the SAME machinery, so `teach` holds
    // one rule store per target and `R()` points at whichever is being edited.
    const mkRule = () => ({
        sig: null, pattern: null, goodSigs: [],
        baseExcludes: [], baseExcludeSigs: [], excludeGroups: [], excludeSigs: []
    });
    let teach = null;        // { domain, mode, silent, step, target: 'topics'|'next', topics: rule, next: rule }
    let teachPopup = null;
    let hl = [];             // highlighted anchors, with their original styles to restore
    let hoverEl = null;

    const R = () => teach[teach.target];

    function computeExcludePatterns(rule) {
        return (rule || R()).excludeGroups
            .map(g => g.length >= 2 ? deriveFromUrls(g) : digitGen(g[0]))
            .filter(p => typeof p === 'string' && p);
    }

    // The pager candidates on this page: every anchor sharing the taught next-link
    // position. Deliberately NOT filtered like topic links — page numbers are bare
    // digits, which collectAnchors drops.
    function pagerRecords(sig) {
        if (!sig) return [];
        return allAnchors(document, location.href).filter(r => signature(r.a, true) === sig);
    }

    // The pager rule as detectNextRecord wants it, including edits not yet saved.
    function liveNextCfg() {
        const r = teach.next;
        return {
            nextSig: r.sig,
            nextExclude: r.baseExcludes.concat(computeExcludePatterns(r)),
            nextExcludeSigs: r.baseExcludeSigs.concat(r.excludeSigs)
        };
    }
    // Anchors on the live page matched by a rule ({ sig, pattern } — a stored site cfg
    // or the in-progress teach state): structure UNIONED with the URL pattern, exactly
    // what detectForSite captures, but keeping the anchor elements so they can be
    // highlighted. Must stay a union: when this used the pattern only as a fallback,
    // the green preview showed just the structure matches (e.g. 25) while capture took
    // structure ∪ pattern (e.g. 57), and the extras were invisible to the Exceptions
    // flow — clicking them did nothing because pickException ignores links outside
    // includedRecords().
    function ruleRecords(rule) {
        const byUrl = new Map();
        const add = (r) => {
            const prev = byUrl.get(r.url);
            if (!prev || r.text.length > prev.text.length) byUrl.set(r.url, r);
        };
        if (rule.sig) clusterForSig(rule.sig).forEach(add);
        if (rule.pattern) {
            let rx;
            try { rx = new RegExp(rule.pattern, 'i'); } catch (_) { rx = null; }
            if (rx) {
                for (const r of (collectAnchors(document, location.href, false) || [])) {
                    if (rx.test(r.urlObj.pathname + r.urlObj.search)) add(r);
                }
            }
        }
        return Array.from(byUrl.values());
    }

    // Split matched records by the exception rules: what survives vs what they remove.
    function splitByExceptions(recs, exRxSrc, exSigs) {
        const rxs = compileExcludes(exRxSrc);
        const inc = [], exc = [];
        for (const r of recs) {
            if (excludedBySig(r.a, exSigs) || excludedByRx(r.urlObj, rxs)) exc.push(r);
            else inc.push(r);
        }
        return { inc, exc };
    }

    const matchedRecords = () =>
        (teach.target === 'next') ? pagerRecords(R().sig) : ruleRecords(R());
    function includedRecords() {
        const r = R();
        return splitByExceptions(matchedRecords(),
            r.baseExcludes.concat(computeExcludePatterns(r)),
            r.baseExcludeSigs.concat(r.excludeSigs)).inc;
    }

    // ---------------- Highlight painting ----------------
    // `outline` alone is unreliable across forums: an anchor whose own box is
    // degenerate (icon links, links whose children are floated or absolutely
    // positioned, links that wrap block content) renders as a stray line beside the
    // text instead of a box. Two mitigations: paint the nearest ancestor that
    // actually has a box, and tint the background as well, which shows up even when
    // the outline is drawn oddly.
    const HL_PROPS = ['outline', 'outlineOffset', 'backgroundColor', 'borderRadius'];
    function paintTarget(a) {
        let el = a;
        for (let i = 0; i < 3 && el && el.getBoundingClientRect; i++) {
            const r = el.getBoundingClientRect();
            if (r.width >= 8 && r.height >= 8) return el;
            el = el.parentElement;
        }
        return a;
    }
    function paintHl(store, a, color) {
        if (!a) return;
        const el = paintTarget(a);
        const saved = { el };
        for (const p of HL_PROPS) saved[p] = el.style[p];
        store.push(saved);
        el.style.outline = '3px solid ' + color;
        el.style.outlineOffset = '1px';
        el.style.backgroundColor = color + '40';   // #rrggbb + alpha
        el.style.borderRadius = '3px';
    }
    function unpaintHl(store) {
        for (const h of store) for (const p of HL_PROPS) h.el.style[p] = h[p];
        store.length = 0;
    }

    function clearHighlights() { unpaintHl(hl); }
    function applyHighlights(records, color) {
        clearHighlights();
        for (const r of records) paintHl(hl, r.a, color || '#a6e3a1');
    }

    function popBtn(label, bg, fg) {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = 'padding: 6px 14px; border-radius: 6px; border: none; font-size: 13px;' +
            'font-weight: 700; cursor: pointer; background: ' + bg + '; color: ' + (fg || '#1e1e2e') + '; white-space: nowrap;';
        return b;
    }

    function buildPopup() {
        teachPopup = document.createElement('div');
        teachPopup.id = 'fs-teach';
        teachPopup.style.cssText = 'all: initial;';
        const root = teachPopup.attachShadow({ mode: 'open' });
        const st = document.createElement('style');
        st.textContent = ':host { all: initial; } * { box-sizing: border-box; }';
        root.appendChild(st);
        const wrap = document.createElement('div');
        wrap.style.cssText = `
            position: fixed; top: 45%; left: 50%; transform: translate(-50%, -50%);
            z-index: 2147483647; width: 400px; max-width: 92vw;
            background: #1e1e2e; color: #cdd6f4; border: 2px solid #ffffff; border-radius: 10px;
            padding: 14px 16px; font: 13px/1.5 system-ui, sans-serif;
            box-shadow: 0 10px 40px rgba(0,0,0,0.6); cursor: move;
            display: flex; flex-direction: column; gap: 10px;
        `;
        // Centered so it must be dealt with, but draggable so it can be moved aside.
        wrap.addEventListener('mousedown', (e) => {
            if (/^(BUTTON|INPUT)$/.test(e.target.tagName)) return;
            const r = wrap.getBoundingClientRect();
            wrap.style.transform = 'none';
            wrap.style.left = r.left + 'px';
            wrap.style.top = r.top + 'px';
            const ox = e.clientX - r.left, oy = e.clientY - r.top;
            const onMove = (ev) => {
                wrap.style.left = (ev.clientX - ox) + 'px';
                wrap.style.top = (ev.clientY - oy) + 'px';
            };
            const onUp = () => {
                window.removeEventListener('mousemove', onMove, true);
                window.removeEventListener('mouseup', onUp, true);
            };
            window.addEventListener('mousemove', onMove, true);
            window.addEventListener('mouseup', onUp, true);
            e.preventDefault();
        });
        const msg = document.createElement('div');
        // pre-wrap: the pager steps show a URL on its own line (textContent only —
        // never innerHTML, which Trusted Types sites reject).
        msg.style.cssText = 'font-weight: 600; white-space: pre-wrap; word-break: break-word;';
        const extra = document.createElement('div');
        extra.style.cssText = 'display: flex; flex-direction: column; gap: 6px;';
        const btns = document.createElement('div');
        btns.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap;';
        wrap.append(msg, extra, btns);
        root.appendChild(wrap);
        document.documentElement.appendChild(teachPopup);
        teachPopup._msg = msg;
        teachPopup._extra = extra;
        teachPopup._btns = btns;
    }

    function setPopup(text, buttons, extraBuild) {
        if (!teachPopup) return;
        teachPopup._msg.textContent = text;
        while (teachPopup._extra.firstChild) teachPopup._extra.removeChild(teachPopup._extra.firstChild);
        while (teachPopup._btns.firstChild) teachPopup._btns.removeChild(teachPopup._btns.firstChild);
        if (extraBuild) extraBuild(teachPopup._extra);
        for (const [label, bg, fg, fn] of buttons) {
            const b = popBtn(label, bg, fg);
            b.addEventListener('click', fn);
            teachPopup._btns.appendChild(b);
        }
    }

    function onCaptureMove(e) {
        // Hover hint only while we're waiting for a pick (would fight the green
        // verification outlines otherwise).
        if (!teach || (teach.step !== 'topic' && teach.step !== 'next')) return;
        const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (hoverEl && hoverEl !== a) { hoverEl.style.outline = hoverEl._fsOldOutline || ''; hoverEl = null; }
        if (a && a !== hoverEl) {
            hoverEl = a;
            a._fsOldOutline = a.style.outline;
            a.style.outline = '2px solid #89b4fa';
            a.style.outlineOffset = '1px';
        }
    }
    function onCaptureKey(e) { if (e.key === 'Escape') cancelCapture(); }
    function onCaptureClick(e) {
        if (!teach) return;
        const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (!a) return;                 // non-link clicks (incl. our popup buttons) pass through
        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        if (teach.step === 'topic') pickTopic(a);
        else if (teach.step === 'except') pickException(a);
        else if (teach.step === 'next') pickNext(a);
        // 'verify': link clicks are swallowed — use the popup buttons
    }

    function enterCaptureMode() {
        buildPopup();
        document.addEventListener('click', onCaptureClick, true);
        document.addEventListener('mouseover', onCaptureMove, true);
        document.addEventListener('keydown', onCaptureKey, true);
        try { document.body.style.cursor = 'crosshair'; } catch (_) {}
    }

    // Load the stored pager rule into a teach rule store (so an edit starts from what
    // the site already knows and Save can append rather than overwrite).
    function loadNextRule(cfg) {
        const r = mkRule();
        r.sig = cfg.nextSig || null;
        r.goodSigs = (cfg.nextGoodSigs || []).slice();
        r.baseExcludes = (cfg.nextExclude || []).slice();
        r.baseExcludeSigs = (cfg.nextExcludeSigs || []).slice();
        return r;
    }

    function startGuidedTeach(domain, silent) {
        teach = {
            domain, mode: 'full', step: 'topic', silent: !!silent, target: 'topics',
            topics: mkRule(), next: mkRule()
        };
        enterCaptureMode();
        stepTopic();
    }

    // Wipe the stored rules, then teach fresh. Cancel/Esc leaves them wiped — same
    // contract whether it was launched from Settings or from the bar's debug drawer.
    function wipeAndTeach(domain, silent) {
        const s = getSites();
        if (s[domain]) {
            s[domain].sig = null; s[domain].pattern = null; s[domain].nextSig = null;
            s[domain].exclude = []; s[domain].excludeSigs = []; s[domain].goodSigs = [];
            s[domain].nextExclude = []; s[domain].nextExcludeSigs = []; s[domain].nextGoodSigs = [];
            saveSites(s);
        }
        startGuidedTeach(domain, silent);
    }

    // Pager only: the taught next-link position outranks auto-detection, so this is
    // how a wrong "next" gets corrected without re-teaching the thread links. Also
    // the way to check, from any page of a list, which link the tour will follow.
    function startNextTeach(domain) {
        const cfg = getSites()[domain] || {};
        teach = {
            domain, mode: 'nextonly', step: 'next', silent: true, target: 'next',
            topics: mkRule(), next: loadNextRule(cfg)
        };
        enterCaptureMode();
        enterNextDetect();
    }

    // Exceptions-only flow: edits the stored thread rule additively, so nothing is
    // wiped and Cancel is a true no-op.
    function startExceptionTeach(domain, silent) {
        const cfg = getSites()[domain] || {};
        const t = mkRule();
        t.sig = cfg.sig || null;
        t.pattern = cfg.pattern || null;
        t.goodSigs = (cfg.goodSigs || []).slice();
        t.baseExcludes = (cfg.exclude || []).slice();
        t.baseExcludeSigs = (cfg.excludeSigs || []).slice();
        teach = {
            domain, mode: 'except', step: 'except', silent: !!silent, target: 'topics',
            topics: t, next: mkRule()
        };
        enterCaptureMode();
        enterExcept();
    }

    function exitCapture() {
        document.removeEventListener('click', onCaptureClick, true);
        document.removeEventListener('mouseover', onCaptureMove, true);
        document.removeEventListener('keydown', onCaptureKey, true);
        if (hoverEl) { hoverEl.style.outline = hoverEl._fsOldOutline || ''; hoverEl = null; }
        clearHighlights();
        try { document.body.style.cursor = ''; } catch (_) {}
        if (teachPopup) { teachPopup.remove(); teachPopup = null; }
        teach = null;
        rescan();
    }
    function cancelCapture() { exitCapture(); } // taught rules were wiped when Teach was clicked — they stay wiped

    function stepTopic(note) {
        teach.step = 'topic';
        setPopup((note ? note + '  ' : '') + 'Click the link to the FIRST thread (topic) in the list on this page.',
            [
                ['Paste a link instead', '#45475a', '#cdd6f4', stepPaste],
                ['Cancel', '#45475a', '#cdd6f4', cancelCapture]
            ]);
    }

    function stepPaste() {
        setPopup('Paste a thread (topic) link that appears on this page:',
            [
                ['Back', '#45475a', '#cdd6f4', () => stepTopic()],
                ['Cancel', '#45475a', '#cdd6f4', cancelCapture]
            ],
            (extra) => {
                const row = document.createElement('div');
                row.style.cssText = 'display: flex; gap: 6px;';
                const inp = document.createElement('input');
                inp.type = 'text';
                inp.placeholder = 'https://…';
                inp.style.cssText = 'flex: 1; padding: 6px 10px; border-radius: 6px; border: 1px solid #45475a;' +
                    'background: #313244; color: #cdd6f4; font-size: 13px; outline: none; cursor: text;';
                const goBtn = popBtn('Analyze', '#89b4fa');
                const err = document.createElement('div');
                err.style.cssText = 'font-size: 12px; color: #f38ba8;';
                const run = () => {
                    const res = analyzeExample(inp.value);
                    if (res.error) { err.textContent = res.error; return; }
                    adoptRule(res.sig, res.pattern);
                };
                goBtn.addEventListener('click', run);
                inp.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
                row.append(inp, goBtn);
                extra.append(row, err);
                setTimeout(() => inp.focus(), 50);
            });
    }

    function pickTopic(a) {
        const sig = signature(a, true);
        const cluster = clusterForSig(sig);
        if (!cluster.length) {
            stepTopic('That looks like site navigation, not a thread link — try a thread title.');
            return;
        }
        adoptRule(sig, cluster.length >= 3 ? deriveFromUrls(cluster.map(r => r.urlObj)) : null);
    }

    function adoptRule(sig, pattern) {
        const r = teach.topics;
        r.sig = sig;
        r.pattern = pattern;
        r.excludeGroups = [];
        r.excludeSigs = [];
        // Seed the known-good chains from the structure matches right away: the
        // inline "Fix wrong links" step needs them to build position-based rules
        // (the wrong links are typically URL-pattern-only matches sitting in
        // different markup, which is exactly what a position rule separates).
        r.goodSigs = sig ? Array.from(new Set(clusterForSig(sig).map(x => sigDeep(x.a)))).slice(0, 12) : [];
        teach.target = 'topics';
        enterVerify();
    }

    function enterVerify(note) {
        teach.step = 'verify';
        teach.target = 'topics';
        const inc = includedRecords();
        applyHighlights(inc);
        setPopup((note ? note + '  ' : '') +
            inc.length + ' link' + (inc.length === 1 ? ' is' : 's are') + ' highlighted in green. ' +
            'Scroll the page and check that ONLY thread links are highlighted. ' +
            'If anything else is highlighted, use “Fix wrong links” and click each one.',
            [
                ['Looks good ✓', '#a6e3a1', null, confirmSave],
                ['Fix wrong links…', '#f9e2af', null, () => enterExcept()],
                ['Cancel', '#45475a', '#cdd6f4', cancelCapture]
            ]);
    }

    // Click-to-exclude. Reached inline from enterVerify (full flow — "Done" returns to
    // the verification step) or as the standalone Exceptions flow ("Save" writes and
    // finishes). Works on either target; the pager wording differs because page
    // numbers, not thread titles, are what should survive.
    function enterExcept(note) {
        teach.step = 'except';
        const inline = teach.mode !== 'except';
        const r = R();
        const inc = includedRecords();
        applyHighlights(inc);
        if (!inc.length && !r.excludeGroups.length && !r.excludeSigs.length) {
            setPopup('The rule doesn’t match any links on this page (or existing exceptions already remove them all). ' +
                'Open a page where the wrong links appear, then try again.',
                [['Close', '#45475a', '#cdd6f4', inline ? (() => enterVerify()) : cancelCapture]]);
            return;
        }
        setPopup((typeof note === 'string' ? note + '  ' : '') +
            'These ' + inc.length + ' highlighted links are what the rule currently catches on this page. ' +
            'Click any that should NOT be included — similar links are removed with it.' +
            (inline ? '' : ' New exceptions are ADDED to the existing ones.') +
            (inline || r.goodSigs.length ? '' :
                ' (This site was taught by an older version — re-teach it once to enable position-based exceptions.)'),
            [
                inline ? ['Done ✓', '#a6e3a1', null, () => enterVerify('Exceptions applied.')]
                       : ['Save ✓', '#a6e3a1', null, saveExceptions],
                ['Cancel', '#45475a', '#cdd6f4', cancelCapture]
            ]);
    }

    function pickException(a) {
        let uo;
        try { uo = new URL(a.href, location.href); } catch (_) { return; }
        const clickedUrl = norm(uo.href);
        const incBefore = includedRecords();
        if (!incBefore.some(r => r.url === clickedUrl)) return; // only highlighted links count

        // Prefer a structural (position) exception: the shortest ancestry prefix of
        // the clicked link that matches NONE of the good chains stored at teach time.
        // Wrong links like "Last post: <thread>" carry a legitimate thread URL that
        // changes constantly — only their markup position identifies them, and the
        // known-good reference must come from the teach page because the wrong links
        // often sit on pages (subforum indexes) with no good links to compare against.
        // A prefix that keeps some on-page links highlighted is preferred; removing
        // everything on this page is allowed only when stored good chains exist to
        // prove real thread links live elsewhere in different markup.
        const rule = R();
        const undo = { groups: rule.excludeGroups.map(g => g.slice()), sigs: rule.excludeSigs.slice() };
        const goods = rule.goodSigs || [];
        const parts = sigDeep(a).split('>');
        let withSurvivors = null, removesAll = null;
        for (let d = 1; d <= parts.length; d++) {
            const prefix = parts.slice(0, d).join('>');
            if (goods.some(g => sigDeepMatches(g, prefix))) continue; // would hit known-good links
            const survivors = incBefore.filter(r => !sigDeepMatches(sigDeep(r.a), prefix)).length;
            if (survivors > 0) { withSurvivors = prefix; break; }
            if (!removesAll && goods.length) removesAll = prefix;
        }
        const pick = withSurvivors || removesAll;
        if (pick) {
            if (!rule.excludeSigs.includes(pick)) rule.excludeSigs.push(pick);
        } else {
            // Structure doesn't discriminate (identical markup) — fall back to URL-shape
            // rules. Join an existing exception group when the merged rule stays
            // specific (still leaves some links highlighted); otherwise start a new group.
            const rxsNow = compileExcludes(rule.baseExcludes.concat(computeExcludePatterns(rule)));
            const exSigsNow = rule.baseExcludeSigs.concat(rule.excludeSigs);
            let placed = false;
            for (const g of rule.excludeGroups) {
                const cand = deriveFromUrls(g.concat([uo]));
                if (!cand) continue;
                let rx;
                try { rx = new RegExp(cand, 'i'); } catch (_) { continue; }
                const remaining = matchedRecords().filter(r =>
                    !excludedBySig(r.a, exSigsNow) &&
                    !excludedByRx(r.urlObj, rxsNow) && !rx.test(r.urlObj.pathname + r.urlObj.search));
                if (remaining.length > 0) { g.push(uo); placed = true; break; }
            }
            if (!placed) rule.excludeGroups.push([uo]);
        }

        const inc = includedRecords();
        // Page numbers all share a URL shape, so a URL-shape rule derived from one of
        // them wipes the whole pager. Never let a pager exception empty the group.
        if (teach.target === 'next' && !inc.length) {
            rule.excludeGroups = undo.groups;
            rule.excludeSigs = undo.sigs;
            enterNextVerify('Skipped — excluding that link would have removed every page link too.');
            return;
        }
        const note = inc.length ? 'Removed.' :
            'Removed — nothing is highlighted on this page now. That is fine on a page with no real thread links; Cancel if it took too much.';
        if (teach.target === 'next') enterNextVerify(note); else enterExcept(note);
    }

    function confirmSave() {
        const sites = getSites();
        const cfg = sites[teach.domain];
        if (cfg) {
            const r = teach.topics;
            cfg.sig = r.sig;
            cfg.pattern = r.pattern;
            cfg.exclude = computeExcludePatterns(r);
            cfg.excludeSigs = r.excludeSigs.slice();
            // Remember the deep markup chains of the STRUCTURE matches only — the
            // known-good reference that later lets an exception rule prove it only
            // removes links in OTHER positions (even on pages with no good links).
            // Deliberately not includedRecords(): that also holds the URL-pattern
            // matches, which are exactly the links Exceptions exists to remove —
            // marking them good would make every position rule refuse to fire. Links
            // the user just excluded are dropped too, for the same reason.
            const kept = new Set(includedRecords().map(x => x.url));
            const goodRecs = (r.sig ? clusterForSig(r.sig) : includedRecords()).filter(x => kept.has(x.url));
            cfg.goodSigs = Array.from(new Set(goodRecs.map(x => sigDeep(x.a)))).slice(0, 12);
            saveSites(sites);
        }
        clearHighlights();
        enterNextDetect();
    }

    // ---------------- Teaching: the pager ----------------
    // Auto-detect the next-page link, show it, and make the user confirm it. This is
    // the step that catches the classic failure: a per-post "💬 8" comment-count link
    // is a bare number, so the numeric-page-link heuristic happily treats it as the
    // pager and the tour walks off into a random thread.
    function enterNextDetect(note) {
        teach.target = 'next';
        teach.step = 'confirm';
        clearHighlights();
        const rec = detectNextRecord(document, location.href, liveNextCfg());
        if (!rec) {
            stepNextPick('No “next page” link was found automatically.');
            return;
        }
        if (rec.a) {
            paintHl(hl, rec.a, '#89b4fa');
            try { rec.a.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
        }
        setPopup((note ? note + '  ' : '') +
            'This is the link I would follow for the next page of threads (highlighted in blue):\n' +
            rec.url + '\n(found via ' + rec.how + ')\n\n' +
            'Is that the link to page 2 of this list?',
            [
                ['Yes ✓', '#a6e3a1', null, () => adoptNext(rec)],
                ['No — I’ll click it', '#f9e2af', null, () => stepNextPick()],
                ['There is no page 2', '#45475a', '#cdd6f4', () => saveNext(true)]
            ]);
    }

    function stepNextPick(note) {
        teach.target = 'next';
        teach.step = 'next';
        clearHighlights();
        setPopup((note ? note + '  ' : '') +
            'Click the link to page 2 of this list — a numbered page link, not “Last”. ' +
            'The tour uses the numbers to work out which page comes after the one it is on.',
            [['There is no page 2', '#45475a', '#cdd6f4', () => saveNext(true)],
             ['Cancel', '#45475a', '#cdd6f4', cancelCapture]]);
    }

    function pickNext(a) {
        const rule = teach.next;
        rule.sig = signature(a, true);
        rule.goodSigs = [sigDeep(a)];
        rule.excludeGroups = [];
        rule.excludeSigs = [];
        enterNextVerify('Learned that spot.');
    }

    // Confirming an auto-detected link still records its position, so later pages are
    // resolved by the taught rule instead of re-running the guesswork that just
    // happened to be right here. A <link rel=next> in the head has no anchor to
    // learn from — accept it and keep relying on auto-detection.
    function adoptNext(rec) {
        if (!rec.a) { saveNext(false, 'The next-page link is declared in the page header — nothing to learn.'); return; }
        const rule = teach.next;
        rule.sig = signature(rec.a, true);
        rule.goodSigs = [sigDeep(rec.a)];
        enterNextVerify();
    }

    // Verify the pager the same way threads are verified: everything sharing the
    // taught position is highlighted (yellow), the link that will actually be
    // followed is blue, and clicking a highlighted link excludes it.
    function enterNextVerify(note) {
        teach.target = 'next';
        teach.step = 'except';
        const inc = includedRecords();
        const chosen = detectNextRecord(document, location.href, liveNextCfg());
        clearHighlights();
        if (chosen && chosen.a) paintHl(hl, chosen.a, '#89b4fa');
        for (const r of inc) if (!chosen || r.a !== chosen.a) paintHl(hl, r.a, '#f9e2af');
        if (chosen && chosen.a) {
            try { chosen.a.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
        }
        setPopup((note ? note + '  ' : '') +
            'Blue = the link the tour will follow next:\n' + (chosen ? chosen.url : '(none — the tour would stop here)') + '\n\n' +
            'Yellow = the ' + Math.max(0, inc.length - (chosen && chosen.a ? 1 : 0)) + ' other link(s) in that same spot. ' +
            'Click any highlighted link that is NOT part of this list’s page numbers.',
            [
                ['Looks good ✓', '#a6e3a1', null, () => saveNext(false)],
                ['Click a different link', '#f9e2af', null, () => stepNextPick()],
                ['Cancel', '#45475a', '#cdd6f4', cancelCapture]
            ]);
    }

    function saveNext(none, why) {
        const rule = teach.next;
        const sites = getSites();
        const cfg = sites[teach.domain];
        if (cfg) {
            if (none) {
                cfg.nextSig = null; cfg.nextExclude = []; cfg.nextExcludeSigs = []; cfg.nextGoodSigs = [];
            } else if (rule.sig) {
                cfg.nextSig = rule.sig;
                cfg.nextExclude = rule.baseExcludes.concat(computeExcludePatterns(rule));
                cfg.nextExcludeSigs = rule.baseExcludeSigs.concat(rule.excludeSigs);
                cfg.nextGoodSigs = rule.goodSigs.slice(0, 4);
            }
            saveSites(sites);
        }
        finishTeach(none ? '✓ Saved — no next page on this list.'
            : (why ? '✓ Saved. ' + why : '✓ Saved, including the next-page link.'));
    }

    // Exceptions flow: append the new rules to the stored ones — never overwrite.
    function saveExceptions() {
        const r = teach.topics;
        const addedRx = computeExcludePatterns(r).filter(p => !r.baseExcludes.includes(p));
        const addedSigs = r.excludeSigs.filter(s => !r.baseExcludeSigs.includes(s));
        const n = addedRx.length + addedSigs.length;
        if (n) {
            const sites = getSites();
            const cfg = sites[teach.domain];
            if (cfg) {
                cfg.exclude = r.baseExcludes.concat(addedRx);
                cfg.excludeSigs = r.baseExcludeSigs.concat(addedSigs);
                saveSites(sites);
            }
        }
        finishTeach(n
            ? '✓ Added ' + n + ' exception rule' + (n === 1 ? '' : 's') + '.'
            : 'No exceptions were added — nothing changed.');
    }

    function finishTeach(msgText) {
        teach.step = 'done';
        const silent = !!teach.silent;   // exitCapture nulls `teach` — read it now
        setPopup(msgText, []);
        setTimeout(() => { exitCapture(); if (!silent) openSettings(); }, 1400);
    }

    // ---------------- UI: floating bar ----------------
    let bar;
    let liveObserver = null;   // grows the captured list on a list page as content lazy-loads
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

    function hideBar() {
        if (liveObserver) { liveObserver.disconnect(); liveObserver = null; }
        dbgClearHl();
        if (bar) { bar.remove(); bar = null; }
    }

    // ---------------- Debug drawer ----------------
    // Answers "why did the tour pick THAT link?" without opening Settings: highlights
    // exactly what the taught rule matches on this page, what the exceptions strip out
    // of it, and which link the script believes is "next page" — plus, on a topic page,
    // which list page the current topic was captured from.
    const dbg = { found: false, excl: false, next: false };
    let dbgHl = [];
    let drawerOpen = false;

    const dbgClearHl = () => unpaintHl(dbgHl);
    function dbgMark(els, color) {
        for (const el of els) paintHl(dbgHl, el, color);
    }

    // Re-derive the three debug sets and paint whichever toggles are on.
    function dbgRefresh(cfg) {
        dbgClearHl();
        const empty = { inc: [], exc: [], next: null, taught: false };
        if (!cfg) return empty;
        const taught = !!(cfg.sig || cfg.pattern);
        let recs;
        if (taught) {
            recs = ruleRecords(cfg);
        } else {
            // Un-taught site: the heuristic returns URLs only, so map them back to
            // anchors to have something to outline.
            const urls = new Set((detectForSite(document, location.href, cfg) || []).map(t => t.url));
            recs = (collectAnchors(document, location.href, true) || []).filter(r => urls.has(r.url));
        }
        const { inc, exc } = splitByExceptions(recs, cfg.exclude, cfg.excludeSigs);
        const next = detectNextRecord(document, location.href, cfg);
        if (dbg.found) dbgMark(inc.map(r => r.a), '#a6e3a1');
        if (dbg.excl) dbgMark(exc.map(r => r.a), '#f38ba8');
        if (dbg.next && next) {
            dbgMark([next.a], '#89b4fa');
            // The rest of the taught pager in yellow, so it's obvious whether the blue
            // link really is the next number in that list.
            if (cfg.nextSig) {
                dbgMark(pagerRecords(cfg.nextSig)
                    .filter(r => r.a !== next.a && !excludedBySig(r.a, cfg.nextExcludeSigs))
                    .map(r => r.a), '#f9e2af');
            }
        }
        return { inc, exc, next, taught };
    }

    function dbgBtn(label, title) {
        const b = document.createElement('button');
        b.textContent = label;
        b.title = title || '';
        Object.assign(b.style, {
            cursor: 'pointer', border: 'none', borderRadius: '6px',
            padding: '3px 7px', font: 'inherit', fontSize: '11px', fontWeight: '600',
            background: 'rgba(255,255,255,0.14)', color: '#fff'
        });
        return b;
    }

    // The tiny ⚙ / ✕ header, kept on BOTH the capture pill and the tour bar so the
    // widget can always be dismissed and inspected.
    function mkBarTools(site, tour, idx) {
        const row = document.createElement('div');
        Object.assign(row.style, { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '4px' });

        const tiny = (label, title) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.title = title;
            Object.assign(b.style, {
                cursor: 'pointer', border: 'none', background: 'transparent', color: '#fff',
                font: 'inherit', fontSize: '11px', lineHeight: '1', padding: '1px 3px', opacity: '0.65'
            });
            b.addEventListener('mouseenter', () => b.style.opacity = '1');
            b.addEventListener('mouseleave', () => b.style.opacity = '0.65');
            return b;
        };

        const gear = tiny('⚙', 'Debug / teaching tools for this site');
        const close = tiny('✕', 'Hide the Forum Stumbler bar on this page');
        close.addEventListener('click', hideBar);
        gear.addEventListener('click', () => {
            drawerOpen = !drawerOpen;
            const existing = bar.querySelector('[data-fs-drawer]');
            if (existing) existing.remove();
            // Prepended: the bar sits bottom-right, so a first child grows upward.
            if (drawerOpen) bar.insertBefore(buildDrawer(site, tour, idx), bar.firstChild);
        });

        row.append(gear, close);
        return row;
    }

    function buildDrawer(site, tour, idx) {
        const cfg = site ? site.cfg : null;
        const wrap = document.createElement('div');
        wrap.setAttribute('data-fs-drawer', '1');
        Object.assign(wrap.style, {
            display: 'flex', flexDirection: 'column', gap: '6px',
            padding: '7px 8px', marginBottom: '3px', borderRadius: '8px',
            background: 'rgba(255,255,255,0.10)', width: '300px', maxWidth: '80vw'
        });

        const info = document.createElement('div');
        Object.assign(info.style, {
            fontSize: '11px', lineHeight: '1.45', opacity: '0.9',
            wordBreak: 'break-all', whiteSpace: 'normal'
        });

        const toggles = document.createElement('div');
        Object.assign(toggles.style, { display: 'flex', gap: '5px', flexWrap: 'wrap' });
        const actions = document.createElement('div');
        Object.assign(actions.style, { display: 'flex', gap: '5px', flexWrap: 'wrap' });

        const paint = [];
        const update = (scrollToNext) => {
            const r = dbgRefresh(cfg);
            for (const p of paint) p();
            while (info.firstChild) info.removeChild(info.firstChild);
            const line = (t, color) => {
                const e = document.createElement('div');
                e.textContent = t;
                if (color) e.style.color = color;
                info.appendChild(e);
            };
            if (!cfg) {
                line('This site is not in the site list.');
            } else {
                line('Matched ' + (r.inc.length + r.exc.length) + ' · excluded ' + r.exc.length +
                    ' · captured ' + r.inc.length + (r.taught ? '' : ' (heuristic — not taught)'));
                line('Next page: ' + (r.next ? r.next.url : 'none found'),
                    r.next ? '#89b4fa' : '#f9e2af');
                if (r.next) line('  ↳ found via ' + r.next.how + (r.next.a ? '' : ' (in <head>, nothing to highlight)'), '#9399b2');
            }
            if (tour && typeof idx === 'number') {
                const src = (tour.sources && tour.sources[idx]) || tour.source || 'unknown';
                line('Topic ' + (idx + 1) + ' of ' + tour.urls.length + ' was captured from:', '#cdd6f4');
                line('  ' + src, '#f9e2af');
            }
            if (scrollToNext && dbg.next && r.next && r.next.a) {
                try { r.next.a.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
            }
        };

        const mkToggle = (label, key, color, title) => {
            const b = dbgBtn(label, title);
            const repaint = () => {
                b.style.background = dbg[key] ? color : 'rgba(255,255,255,0.14)';
                b.style.color = dbg[key] ? '#1e1e2e' : '#fff';
            };
            paint.push(repaint);
            b.addEventListener('click', () => { dbg[key] = !dbg[key]; update(key === 'next'); });
            toggles.appendChild(b);
        };
        mkToggle('Found', 'found', '#a6e3a1', 'Outline every link this page contributes to a tour');
        mkToggle('Excluded', 'excl', '#f38ba8', 'Outline links the rule matches but the exceptions remove');
        mkToggle('Next link', 'next', '#89b4fa', 'Outline (and scroll to) the link the tour follows for page 2');

        if (site) {
            const d = site.domain;
            const teachBtn = dbgBtn('Re-teach', 'Erase this site’s rules and learn the thread links again from this page');
            teachBtn.addEventListener('click', () => { hideBar(); wipeAndTeach(d, true); });
            const excBtn = dbgBtn('Exceptions', 'Click wrong links to exclude them — added on top of the existing exceptions');
            excBtn.addEventListener('click', () => { hideBar(); startExceptionTeach(d, true); });
            const nextBtn = dbgBtn('Check next link', 'Show the link the tour will follow from this page, and correct it if it is wrong');
            nextBtn.addEventListener('click', () => { hideBar(); startNextTeach(d); });
            const setBtn = dbgBtn('Settings…', 'Open the full Forum Stumbler settings');
            setBtn.addEventListener('click', openSettings);
            actions.append(teachBtn, excBtn, nextBtn, setBtn);
            if (!(cfg && (cfg.sig || cfg.pattern))) {
                excBtn.disabled = true;
                excBtn.style.opacity = '0.4';
                excBtn.title = 'Teach the thread links first';
            }
        }

        update(false);
        wrap.append(info, toggles, actions);
        return wrap;
    }

    // ---------------- Tour lifecycle ----------------
    function startTour(topics, nextPage) {
        const here = norm(location.href);
        const tour = {
            urls: topics.map(t => t.url),
            titles: topics.map(t => t.text),
            // Which list page each topic was captured from — the debug drawer shows it,
            // which is the only way to tell a stray match on the index apart from a
            // topic pulled off a wrongly-detected "next page".
            sources: topics.map(() => here),
            source: here,
            sourceTitle: (document.title || location.hostname).trim(),
            nextPage: nextPage || null,
            ts: Date.now()
        };
        saveTour(tour);
        setPending(0);
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
        if (!Array.isArray(tour.sources)) tour.sources = tour.urls.map(() => tour.source || '');
        tour.urls = tour.urls.concat(addUrls);
        tour.titles = tour.titles.concat(addTitles);
        const from = newNextBase ? norm(newNextBase) : '';
        tour.sources = tour.sources.concat(addUrls.map(() => from));
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
            setPending(tour.urls.indexOf(first));
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
        const pending = takePending();

        // A running tour owns its pages regardless of scan scope: it was started from
        // an allowed index page, lives only in this tab, and dies with it.
        if (tour && tour.urls) {
            let idx = tour.urls.indexOf(here);
            // Forums may redirect a stored topic URL somewhere slightly different —
            // Discourse appends the last-read post (/t/slug/123 → /t/slug/123/4), Reddit
            // adds tracking. Fall back to a separator-guarded prefix match, then to the
            // index we recorded when OUR button did the navigating.
            if (idx === -1) idx = tour.urls.findIndex(u => here.startsWith(u + '/') || here.startsWith(u + '?'));
            if (idx === -1 && pending !== null && pending >= 0 && pending < tour.urls.length) idx = pending;
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
        drawerOpen = false;
        bar.appendChild(mkBarTools(getSiteFor(location.hostname), tour, idx));
        const goTopic = (i) => { setPending(i); go(tour.urls[i]); };

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
                if (!isNaN(n) && n >= 1 && n <= tour.urls.length && n !== idx + 1) goTopic(n - 1);
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
            if (idx > 0) goTopic(idx - 1);
            else if (tour.source) go(tour.source);
        });

        const isLast = idx === tour.urls.length - 1;
        const canChain = AUTO_CHAIN && tour.nextPage;
        if (isLast && canChain) { next.textContent = '⏭'; next.title = 'Pull next page → first new topic'; }
        if (isLast && !canChain) { next.style.opacity = '0.4'; next.style.cursor = 'default'; }
        next.addEventListener('click', () => {
            if (!isLast) goTopic(idx + 1);
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
                if (first) { setPending(tour.urls.indexOf(first)); go(first); return; }
            }
            if (resume) delResume();
            buildStartPill(site);
        } else {
            if (resume) delResume();
            startWaitObserver(site, tour);
        }
    }

    // The capture pill. The captured list only ever GROWS: infinite-scroll pages
    // (Reddit) add and remove DOM as you scroll, so each re-detect may see a different
    // window of links — accumulating keeps everything seen so far.
    function buildStartPill(site) {
        if (waitObserver) { waitObserver.disconnect(); waitObserver = null; }
        buildBar(); clearBar();
        drawerOpen = false;
        bar.appendChild(mkBarTools(site, null, null));

        const row = mkRow();
        const start = mkBtn('📑 … — Start', 'Capture these topics and open the first (scroll to gather more)');
        const acc = new Map();  // url -> {url, text}, insertion order = discovery order
        let lastNext = null;

        const recompute = () => {
            const found = detectForSite(document, location.href, site.cfg) || [];
            for (const t of found) if (!acc.has(t.url)) acc.set(t.url, t);
            const nx = detectNextPage(document, location.href, site.cfg);
            if (nx) lastNext = nx;
            const n = acc.size;
            start.textContent = `📑 ${n} topic${n === 1 ? '' : 's'} — Start`;
        };
        recompute();

        start.addEventListener('click', () => {
            if (acc.size) startTour(Array.from(acc.values()), lastNext);
        });
        row.append(start);
        bar.append(row);

        // Live growth, event-driven (only fires when the DOM actually changes), throttled.
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
        // Outlines point at anchors that may be about to vanish (SPA re-render) —
        // restore them before the bar is rebuilt.
        dbgClearHl();
        drawerOpen = false;
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
        descTeach.textContent = 'The ⚙ button on the floating bar opens a per-site drawer that highlights what is captured, what the exceptions remove, and which link is treated as “next page” (with a way to re-teach it). Teach threads: a popup guides you through the whole setup — click the first thread link, verify the green highlights (clicking wrong ones to exclude them), then confirm or click the “next page” link and check the pager (re-teaching wipes the old rules, exceptions included). Exceptions: on any page, highlights what the rule catches so you can click wrong links to exclude them — new exceptions are added to the existing ones.';
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

        // Status line
        const ioStatus = document.createElement('span');
        ioStatus.style.cssText = 'font-size: 12px; color: #a6e3a1; margin-left: 4px;';
        function flashStatus(msg, color) {
            ioStatus.style.color = color || '#a6e3a1';
            ioStatus.textContent = msg;
            clearTimeout(ioStatus._t);
            ioStatus._t = setTimeout(() => { ioStatus.textContent = ''; }, 4000);
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
                row.style.cssText = 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;';
                const label = document.createElement('span');
                label.style.cssText = 'font-size: 13px; word-break: break-all; flex: 1; font-weight: 600;';
                label.textContent = d;
                row.appendChild(label);

                if (taught) {
                    const badge = document.createElement('span');
                    badge.style.cssText = 'font-size: 11px; color: #a6e3a1; flex-shrink: 0;';
                    const nExcl = cfg.exclude.length + cfg.excludeSigs.length;
                    badge.textContent = 'taught' + (cfg.nextSig ? ' +next' : '') +
                        (nExcl ? ' +' + nExcl + ' excl' : '');
                    badge.title = 'Structure: ' + (cfg.sig || '(none)') +
                        (cfg.pattern ? '\nURL pattern: ' + cfg.pattern : '') +
                        (cfg.nextSig ? '\nNext-page: ' + cfg.nextSig : '') +
                        (cfg.nextExclude.length ? '\nPager URL exceptions:\n' + cfg.nextExclude.join('\n') : '') +
                        (cfg.nextExcludeSigs.length ? '\nPager position exceptions:\n' + cfg.nextExcludeSigs.join('\n') : '') +
                        (cfg.exclude.length ? '\nURL exceptions:\n' + cfg.exclude.join('\n') : '') +
                        (cfg.excludeSigs.length ? '\nPosition exceptions:\n' + cfg.excludeSigs.join('\n') : '');
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

                // Teach threads: wipes the stored rules immediately (Cancel/Esc in
                // the guided flow leaves them wiped), closes settings, starts guiding.
                const teachBtn = smallBtn(taught ? 'Re-teach threads' : 'Teach threads', '#89b4fa');
                if (onSite) {
                    teachBtn.title = 'Erase the taught rules (exceptions included) and learn the thread links fresh from this page';
                    teachBtn.addEventListener('click', () => {
                        host.remove();
                        wipeAndTeach(d);
                    });
                } else {
                    teachBtn.style.opacity = '0.4';
                    teachBtn.style.cursor = 'default';
                    teachBtn.title = 'Open a subforum page on ' + d + ' to teach it';
                }
                row.appendChild(teachBtn);

                // Exceptions: additive — highlights what the rule catches on the
                // current page, clicks exclude, Save appends to the stored exceptions.
                const excBtn = smallBtn('Exceptions', '#f9e2af');
                if (taught && onSite) {
                    excBtn.title = 'Highlight what the taught rule catches on this page and click wrong links to exclude them — added on top of the existing exceptions';
                    excBtn.addEventListener('click', () => {
                        host.remove();
                        startExceptionTeach(d);
                    });
                } else {
                    excBtn.style.opacity = '0.4';
                    excBtn.style.cursor = 'default';
                    excBtn.title = taught ? 'Open a page on ' + d + ' to add exceptions' : 'Teach the thread links first';
                }
                row.appendChild(excBtn);

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
            sites[d] = {
                all: false, prefixes, pattern: null, sig: null, nextSig: null,
                exclude: [], excludeSigs: [], goodSigs: [],
                nextExclude: [], nextExcludeSigs: [], nextGoodSigs: []
            };
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
                            nextSig: (cfg && typeof cfg.nextSig === 'string') ? cfg.nextSig : null,
                            exclude: (cfg && Array.isArray(cfg.exclude)) ? cfg.exclude.filter(p => typeof p === 'string' && p) : [],
                            excludeSigs: (cfg && Array.isArray(cfg.excludeSigs)) ? cfg.excludeSigs.filter(p => typeof p === 'string' && p) : [],
                            goodSigs: (cfg && Array.isArray(cfg.goodSigs)) ? cfg.goodSigs.filter(p => typeof p === 'string' && p) : [],
                            nextExclude: (cfg && Array.isArray(cfg.nextExclude)) ? cfg.nextExclude.filter(p => typeof p === 'string' && p) : [],
                            nextExcludeSigs: (cfg && Array.isArray(cfg.nextExcludeSigs)) ? cfg.nextExcludeSigs.filter(p => typeof p === 'string' && p) : [],
                            nextGoodSigs: (cfg && Array.isArray(cfg.nextGoodSigs)) ? cfg.nextGoodSigs.filter(p => typeof p === 'string' && p) : []
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
        panel.append(title, desc, addRow, list, ioRow, closeBtn);
        overlay.appendChild(panel);
        root.appendChild(overlay);
        document.documentElement.appendChild(host);
    }

    // ---------------- SPA navigation ----------------
    // Reddit (shreddit) intercepts same-origin navigations with the Navigation API,
    // so location.href assignments and Back/Forward often DON'T reload the page —
    // this script instance survives the "navigation". Without re-rendering, the tour
    // bar never appears after Start, the stale capture pill keeps accumulating, and
    // the pending topic index is consumed by the wrong page after a later refresh.
    // Watch for URL changes and re-render. Skipped mid-teach (exitCapture rescans).
    let lastHref = location.href;
    function onUrlMaybeChanged() {
        setTimeout(() => {
            if (location.href === lastHref) return;
            lastHref = location.href;
            if (teach) return;
            setTimeout(rescan, 250); // let the new view start rendering first
        }, 0);
    }
    if (window.navigation && typeof window.navigation.addEventListener === 'function') {
        window.navigation.addEventListener('navigatesuccess', onUrlMaybeChanged);
    } else {
        // No Navigation API (Firefox): hook the history methods SPAs use. This runs
        // in the userscript sandbox; if the wrapper doesn't forward the assignment,
        // popstate below still covers Back/Forward.
        try {
            for (const m of ['pushState', 'replaceState']) {
                const orig = history[m];
                history[m] = function () { const r = orig.apply(this, arguments); onUrlMaybeChanged(); return r; };
            }
        } catch (_) {}
    }
    window.addEventListener('popstate', onUrlMaybeChanged);

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
