/**
 * Pohjapiirustus-skannerin hakumoottori (DOM-vapaa).
 * Kopioitavissa Gradukseen sellaisenaan: window.FloorplanScanner
 *
 * Etsii nimilistan merkkijonot vektori-PDF:n tekstikerroksesta.
 * Rajauksen sisällön kokoaa käyttöliittymä.
 */
(function (root) {
    'use strict';

    var MIN_TEXT_CHARS = 25;
    var SEED_PAD = 2;

    function transform(m1, m2) {
        return [
            m1[0] * m2[0] + m1[2] * m2[1],
            m1[1] * m2[0] + m1[3] * m2[1],
            m1[0] * m2[2] + m1[2] * m2[3],
            m1[1] * m2[2] + m1[3] * m2[3],
            m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
            m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
        ];
    }

    function normalizeQuery(line) {
        return String(line || '')
            .replace(/[×✕]/g, 'x')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function parseQueries(text) {
        var seen = {};
        var out = [];
        String(text || '').split(/\r?\n/).forEach(function (raw) {
            var trimmed = raw.trim();
            if (!trimmed) return;
            var key = normalizeQuery(trimmed);
            if (!key || seen[key]) return;
            seen[key] = true;
            out.push(trimmed);
        });
        return out;
    }

    function escapeRegex(s) {
        return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function extractPageItems(textContent, viewport, page, file) {
        var items = [];
        var list = (textContent && textContent.items) || [];
        var vt = (viewport && viewport.transform) || [1, 0, 0, 1, 0, 0];
        var scale = (viewport && viewport.scale) || 1;
        var pageNum = page || 1;
        var fileName = file || '';

        for (var i = 0; i < list.length; i++) {
            var it = list[i];
            var s = String((it && it.str) || '');
            if (!s.trim()) continue;
            var tx = transform(vt, it.transform || [1, 0, 0, 1, 0, 0]);
            var ox = tx[4];
            var oy = tx[5];
            var vertical = Math.abs(tx[0]) < Math.abs(tx[1]);
            var wpx = (it.width || 0) * scale;
            var hlen = Math.hypot(tx[2], tx[3]);
            var hpx = (it.height || 0) * scale || hlen || 10;
            if (!wpx) wpx = Math.hypot(tx[0], tx[1]) * (s.length || 1);

            var advLen = Math.hypot(tx[0], tx[1]) || 1;
            var ax = (tx[0] / advLen) * wpx;
            var ay = (tx[1] / advLen) * wpx;
            var hx = hlen ? tx[2] : -(tx[1] / advLen) * hpx;
            var hy = hlen ? tx[3] : (tx[0] / advLen) * hpx;
            var xs = [ox, ox + ax, ox + hx, ox + ax + hx];
            var ys = [oy, oy + ay, oy + hy, oy + ay + hy];
            var minX = Math.min(xs[0], xs[1], xs[2], xs[3]);
            var maxX = Math.max(xs[0], xs[1], xs[2], xs[3]);
            var minY = Math.min(ys[0], ys[1], ys[2], ys[3]);
            var maxY = Math.max(ys[0], ys[1], ys[2], ys[3]);

            items.push({
                text: s,
                x: minX,
                y: minY,
                w: maxX - minX,
                h: maxY - minY,
                vertical: vertical,
                page: pageNum,
                file: fileName
            });
        }
        return items;
    }

    function boxGap(a, b) {
        var ax2 = a.x + a.w;
        var ay2 = a.y + a.h;
        var bx2 = b.x + b.w;
        var by2 = b.y + b.h;
        var dx = Math.max(0, Math.max(a.x - bx2, b.x - ax2));
        var dy = Math.max(0, Math.max(a.y - by2, b.y - ay2));
        return Math.hypot(dx, dy);
    }

    function samePage(a, b) {
        return (a.page || 1) === (b.page || 1) && (a.file || '') === (b.file || '');
    }

    function lineGlyph(it) {
        return Math.max(Math.min(it.w || 8, it.h || 8), 6);
    }

    function looksLikeSizeCode(text) {
        return /\d+\s*\+\s*\d+x\d+|\d+x\d+[a-z]?/i.test(String(text || ''));
    }

    function tokenMatchesQuery(tok, q) {
        if (!tok || !q) return false;
        if (tok === q) return true;
        if (tok.indexOf(q) !== 0) return false;
        if (tok.length === q.length) return true;
        return /[0-9-]/.test(tok.charAt(q.length));
    }

    function textMatchesQuery(text, q) {
        var parts = normalizeQuery(text).split(' ').filter(Boolean);
        for (var i = 0; i < parts.length; i++) {
            if (tokenMatchesQuery(parts[i], q)) return true;
        }
        return false;
    }

    function containsSizeQuery(text, sizeToken) {
        if (!sizeToken) return false;
        var n = normalizeQuery(text);
        var body = escapeRegex(sizeToken);
        return new RegExp('(?<![a-z0-9])' + body + '(?![a-z0-9])').test(n);
    }

    function nearbyHasToken(seed, items, token, maxGap) {
        if (!token) return true;
        if (normalizeQuery(seed.text).split(' ').indexOf(token) >= 0) return true;
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (it === seed || !samePage(seed, it)) continue;
            if (boxGap(seed, it) > maxGap) continue;
            if (normalizeQuery(it.text).split(' ').indexOf(token) >= 0) return true;
        }
        return false;
    }

    function extrasMatch(seed, items, extraTokens) {
        var maxGap = Math.max(lineGlyph(seed) * 4, 36);
        for (var i = 0; i < extraTokens.length; i++) {
            if (!nearbyHasToken(seed, items, extraTokens[i], maxGap)) return false;
        }
        return true;
    }

    function padBBox(it) {
        var pad = SEED_PAD;
        return {
            x: it.x - pad,
            y: it.y - pad,
            w: Math.max(8, it.w + pad * 2),
            h: Math.max(8, it.h + pad * 2)
        };
    }

    function copyBBox(box) {
        if (!box) return null;
        return { x: box.x, y: box.y, w: box.w, h: box.h };
    }

    function boxesNear(a, b, tol) {
        if (!a || !b) return false;
        var pad = tol || 6;
        return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad &&
            a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
    }

    function collapseByLocation(hits) {
        var kept = [];
        (hits || []).forEach(function (hit) {
            var dup = kept.some(function (other) {
                if ((hit.file || '') !== (other.file || '')) return false;
                if ((hit.page || 1) !== (other.page || 1)) return false;
                return boxesNear(hit.bbox, other.bbox, 2);
            });
            if (!dup) kept.push(hit);
        });
        return kept;
    }

    function sortHits(hits) {
        return (hits || []).slice().sort(function (a, b) {
            var fa = String(a.file || '');
            var fb = String(b.file || '');
            if (fa !== fb) return fa < fb ? -1 : 1;
            var pa = a.page || 1;
            var pb = b.page || 1;
            if (pa !== pb) return pa - pb;
            var ay = a.bbox ? a.bbox.y : 0;
            var by = b.bbox ? b.bbox.y : 0;
            if (Math.abs(ay - by) > 4) return ay - by;
            var ax = a.bbox ? a.bbox.x : 0;
            var bx = b.bbox ? b.bbox.x : 0;
            return ax - bx;
        });
    }

    function buildHit(seed, query) {
        return {
            query: query,
            full: query,
            page: seed.page,
            file: seed.file,
            bbox: padBBox(seed)
        };
    }

    function findMatches(queries, items) {
        var list = items || [];
        var results = [];
        var missing = [];

        (queries || []).forEach(function (rawQuery) {
            var query = String(rawQuery || '').trim();
            var q = normalizeQuery(query);
            if (!q) return;
            var qTokens = q.split(' ').filter(Boolean);
            var sizeTokens = qTokens.filter(function (t) { return looksLikeSizeCode(t); });
            var extraTokens = qTokens.filter(function (t) { return !looksLikeSizeCode(t); });
            var matchToken = sizeTokens[0] || qTokens[0];

            var hits = [];
            list.forEach(function (seed) {
                if (sizeTokens.length) {
                    if (!containsSizeQuery(seed.text, matchToken)) return;
                } else if (!textMatchesQuery(seed.text, q)) {
                    return;
                }
                if (extraTokens.length && sizeTokens.length) {
                    if (!extrasMatch(seed, list, extraTokens)) return;
                } else if (!sizeTokens.length && extraTokens.length > 1) {
                    if (!extrasMatch(seed, list, extraTokens.slice(1))) return;
                }
                hits.push(buildHit(seed, query));
            });

            hits = sortHits(collapseByLocation(hits));
            results.push({ query: query, hits: hits });
            if (!hits.length) missing.push(query);
        });

        return { results: results, missing: missing };
    }

    function textsInCrop(items, crop, file, page) {
        if (!crop) return '';
        var fileName = file || '';
        var pageNum = page || 1;
        var picked = (items || []).filter(function (it) {
            if ((it.file || '') !== fileName) return false;
            if ((it.page || 1) !== pageNum) return false;
            var cx = it.x + (it.w || 0) / 2;
            var cy = it.y + (it.h || 0) / 2;
            return cx >= crop.x && cy >= crop.y &&
                cx <= crop.x + crop.w && cy <= crop.y + crop.h;
        });
        picked.sort(function (a, b) {
            if (Math.abs(a.y - b.y) > 4) return a.y - b.y;
            return a.x - b.x;
        });
        return picked.map(function (it) {
            return String(it.text || '').trim();
        }).filter(Boolean).join(' ');
    }

    function totalChars(items) {
        return (items || []).reduce(function (n, it) {
            return n + String(it.text || '').length;
        }, 0);
    }

    root.FloorplanScanner = {
        MIN_TEXT_CHARS: MIN_TEXT_CHARS,
        normalizeQuery: normalizeQuery,
        parseQueries: parseQueries,
        extractPageItems: extractPageItems,
        totalChars: totalChars,
        findMatches: findMatches,
        textsInCrop: textsInCrop,
        copyBBox: copyBBox,
        looksLikeSizeCode: looksLikeSizeCode
    };
})(typeof window !== 'undefined' ? window : globalThis);
