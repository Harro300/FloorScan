/**
 * Pohjapiirustus-skannerin hakumoottori (DOM-vapaa).
 * Kopioitavissa Gradukseen sellaisenaan: window.FloorplanScanner
 */
(function (root) {
    'use strict';

    var ID_RE = /(\d{3,5}(?:-\d+)?)/;
    var MIN_TEXT_CHARS = 25;

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

    function normalizeWithMap(str) {
        var map = [];
        var out = '';
        var prevSpace = false;
        var i = 0;
        var s = String(str || '');
        while (i < s.length && /\s/.test(s[i])) i++;
        for (; i < s.length; i++) {
            var ch = s[i];
            if (ch === '×' || ch === '✕') ch = 'x';
            if (/\s/.test(ch)) {
                if (!prevSpace && out.length) {
                    map.push(i);
                    out += ' ';
                    prevSpace = true;
                }
            } else {
                map.push(i);
                out += ch.toLowerCase();
                prevSpace = false;
            }
        }
        if (out.charAt(out.length - 1) === ' ') {
            out = out.slice(0, -1);
            map.pop();
        }
        return { text: out, map: map };
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
            var x = tx[4];
            var y = tx[5];
            var vertical = Math.abs(tx[0]) < Math.abs(tx[1]);
            var wpx = (it.width || 0) * scale;
            var hpx = (it.height || 0) * scale || Math.hypot(tx[2], tx[3]) || 10;
            if (!wpx) wpx = Math.hypot(tx[0], tx[1]) * (s.length || 1);
            items.push({
                text: s,
                x: vertical ? x - hpx : x,
                y: vertical ? y : y - hpx,
                w: vertical ? hpx : wpx,
                h: vertical ? wpx : hpx,
                vertical: vertical,
                page: pageNum,
                file: fileName
            });
        }
        return items;
    }

    function median(values) {
        if (!values.length) return 10;
        var s = values.slice().sort(function (a, b) { return a - b; });
        var mid = Math.floor(s.length / 2);
        return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }

    function joinLineItems(lineItems) {
        var text = '';
        var spans = [];
        for (var i = 0; i < lineItems.length; i++) {
            var it = lineItems[i];
            if (i > 0) text += ' ';
            var start = text.length;
            text += it.text;
            spans.push({ start: start, end: text.length, item: it });
        }
        return { text: text, spans: spans };
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

    function isNear(a, b) {
        var pad = Math.max(a.h || 0, a.w || 0, b.h || 0, b.w || 0, 8) * 2.5;
        return boxGap(a, b) <= pad;
    }

    function emitChain(lineItems, lines) {
        if (!lineItems.length) return;
        var joined = joinLineItems(lineItems);
        if (!joined.text.trim()) return;
        lines.push({
            text: joined.text,
            spans: joined.spans,
            page: lineItems[0].page,
            file: lineItems[0].file,
            vertical: !!lineItems[0].vertical,
            items: lineItems.slice()
        });
    }

    function chainByProximity(items) {
        var lines = [];
        var current = [];
        (items || []).forEach(function (it) {
            if (!current.length) {
                current = [it];
                return;
            }
            var prev = current[current.length - 1];
            var samePage = (prev.page || 1) === (it.page || 1) && (prev.file || '') === (it.file || '');
            if (samePage && isNear(prev, it)) {
                current.push(it);
            } else {
                emitChain(current, lines);
                current = [it];
            }
        });
        emitChain(current, lines);
        return lines;
    }

    function unionBBox(spans, origStart, origEnd) {
        var box = null;
        for (var i = 0; i < spans.length; i++) {
            var sp = spans[i];
            if (sp.end <= origStart || sp.start >= origEnd) continue;
            var it = sp.item;
            if (!box) {
                box = { x: it.x, y: it.y, w: it.w, h: it.h };
            } else {
                var x2 = Math.max(box.x + box.w, it.x + it.w);
                var y2 = Math.max(box.y + box.h, it.y + it.h);
                box.x = Math.min(box.x, it.x);
                box.y = Math.min(box.y, it.y);
                box.w = x2 - box.x;
                box.h = y2 - box.y;
            }
        }
        return box;
    }

    function isVerticalItem(it) {
        return !!(it.vertical || ((it.h || 0) > (it.w || 0) * 1.15));
    }

    function clusterAlong(items, axisFn, alongFn, axisTol, alongGap, sortSign) {
        var lines = [];
        var sorted = (items || []).slice().sort(function (a, b) {
            var d = axisFn(a) - axisFn(b);
            if (Math.abs(d) > 0.01) return d;
            return alongFn(a) - alongFn(b);
        });
        var buckets = [];
        sorted.forEach(function (it) {
            var axis = axisFn(it);
            var bucket = buckets[buckets.length - 1];
            if (!bucket || Math.abs(axis - bucket.axis) > axisTol) {
                bucket = { axis: axis, items: [] };
                buckets.push(bucket);
            } else {
                bucket.axis = (bucket.axis * bucket.items.length + axis) / (bucket.items.length + 1);
            }
            bucket.items.push(it);
        });
        buckets.forEach(function (bucket) {
            bucket.items.sort(function (a, b) { return alongFn(a) - alongFn(b); });
            var run = [];
            bucket.items.forEach(function (it) {
                if (!run.length) {
                    run = [it];
                    return;
                }
                var prev = run[run.length - 1];
                if (alongFn(it) - alongFn(prev) <= alongGap && isNear(prev, it)) {
                    run.push(it);
                } else {
                    var ordered = sortSign < 0 ? run.slice().reverse() : run;
                    emitChain(ordered, lines);
                    run = [it];
                }
            });
            if (run.length) {
                var orderedRun = sortSign < 0 ? run.slice().reverse() : run;
                emitChain(orderedRun, lines);
            }
        });
        return lines;
    }

    function itemsToLines(items) {
        var list = items || [];
        var lines = chainByProximity(list);
        var vertical = [];
        var horizontal = [];
        list.forEach(function (it) {
            if (isVerticalItem(it)) vertical.push(it);
            else horizontal.push(it);
        });
        var vTol = Math.max(4, median(vertical.map(function (it) { return it.w || 10; })) * 0.8);
        var hTol = Math.max(4, median(horizontal.map(function (it) { return it.h || 10; })) * 0.8);
        var vGap = Math.max(20, median(vertical.map(function (it) { return it.h || 10; })) * 4);
        var hGap = Math.max(20, median(horizontal.map(function (it) { return it.w || 10; })) * 4);
        lines = lines.concat(clusterAlong(vertical, function (it) { return it.x; }, function (it) { return it.y; }, vTol, vGap, -1));
        lines = lines.concat(clusterAlong(horizontal, function (it) { return it.y; }, function (it) { return it.x; }, hTol, hGap, 1));
        return lines;
    }

    function unionItemsBBox(list) {
        var box = null;
        (list || []).forEach(function (it) {
            if (!it) return;
            if (!box) {
                box = { x: it.x, y: it.y, w: it.w, h: it.h };
                return;
            }
            var x2 = Math.max(box.x + box.w, it.x + it.w);
            var y2 = Math.max(box.y + box.h, it.y + it.h);
            box.x = Math.min(box.x, it.x);
            box.y = Math.min(box.y, it.y);
            box.w = x2 - box.x;
            box.h = y2 - box.y;
        });
        return box;
    }

    function pageKey(it) {
        return (it.file || '') + '::' + (it.page || 1);
    }

    var MAX_STACK_ITEMS = 8;

    function isTagNoise(text) {
        var t = String(text || '').trim();
        if (!t) return true;
        if (/^\d{4,}$/.test(t)) return true;
        if (/m²|m2/i.test(t)) return true;
        if (/^h=$/i.test(t)) return true;
        if (t.length > 16) return true;
        return false;
    }

    function looksLikeSizeCode(text) {
        return /\d+\s*\+\s*\d+x\d+|\d+x\d+[a-z]?/i.test(String(text || ''));
    }

    var TYPE_DENY = {
        ak: 1, ks: 1, st: 1, vs: 1, us: 1, ppp: 1, lp: 1, sp: 1, tt: 1
    };

    function isTagToken(text) {
        var t = String(text || '').trim();
        if (!t) return false;
        if (looksLikeSizeCode(t)) return true;
        if (/^\d{2,3}[A-Za-z]$/.test(t)) return true;
        if (/^\d{2,3}$/.test(t) && parseInt(t, 10) <= 250) return true;
        if (/^(VO|TVO|TUO|TLO|SO|WC|dB)$/i.test(t)) return true;
        if (/^SO-\S+$/i.test(t)) return true;
        if (/^NO-?[A-Z]+$/i.test(t)) return true;
        if (/^EI\d+$/i.test(t)) return true;
        if (/^\d{2,3}dB$/i.test(t)) return true;
        if (/^AR=/i.test(t)) return true;
        if (/^[A-Za-z]{2,6}\d{0,2}$/.test(t) && !TYPE_DENY[t.toLowerCase()]) return true;
        return false;
    }

    function isTagNear(a, b) {
        var size = Math.max(
            Math.min(a.h || 8, a.w || 8),
            Math.min(b.h || 8, b.w || 8),
            6
        );
        return boxGap(a, b) <= size * 1.25;
    }

    function sortStackItems(list) {
        var verticalCount = 0;
        list.forEach(function (it) {
            if ((it.h || 0) > (it.w || 0) * 1.1) verticalCount++;
        });
        var rotated = verticalCount * 2 >= list.length;
        return list.slice().sort(function (a, b) {
            if (rotated) {
                var dx = a.x - b.x;
                if (Math.abs(dx) > 1) return dx;
                return b.y - a.y;
            }
            var dy = a.y - b.y;
            if (Math.abs(dy) > 1) return dy;
            return a.x - b.x;
        });
    }

    function itemsToTokens(list) {
        var tokens = [];
        list.forEach(function (it) {
            String(it.text || '').split(/\s+/).forEach(function (part) {
                if (!part) return;
                tokens.push({ text: part, norm: normalizeQuery(part), item: it });
            });
        });
        return tokens;
    }

    function growStack(seed, candidates) {
        var cluster = [seed];
        var queue = [seed];
        function inCluster(it) {
            return cluster.indexOf(it) !== -1;
        }
        while (queue.length && cluster.length < MAX_STACK_ITEMS) {
            var cur = queue.shift();
            for (var i = 0; i < candidates.length; i++) {
                var cand = candidates[i];
                if (inCluster(cand)) continue;
                if (!isTagToken(cand.text)) continue;
                if (looksLikeSizeCode(cand.text)) continue;
                if (!isTagNear(cur, cand)) continue;
                cluster.push(cand);
                queue.push(cand);
                if (cluster.length >= MAX_STACK_ITEMS) break;
            }
        }
        return cluster;
    }

    function itemsToStacks(items) {
        var buckets = {};
        var order = [];
        (items || []).forEach(function (it) {
            if (isTagNoise(it.text)) return;
            var key = pageKey(it);
            if (!buckets[key]) {
                buckets[key] = [];
                order.push(key);
            }
            buckets[key].push(it);
        });

        var stacks = [];
        order.forEach(function (key) {
            var list = buckets[key];
            var used = [];
            function markUsed(cluster) {
                cluster.forEach(function (it) {
                    if (looksLikeSizeCode(it.text) && used.indexOf(it) === -1) used.push(it);
                });
            }
            list.forEach(function (it) {
                if (!looksLikeSizeCode(it.text)) return;
                if (used.indexOf(it) !== -1) return;
                var cluster = growStack(it, list);
                markUsed(cluster);
                var ordered = sortStackItems(cluster);
                var tokens = itemsToTokens(ordered);
                if (!tokens.length) return;
                stacks.push({
                    tokens: tokens,
                    items: ordered,
                    bbox: unionItemsBBox(ordered),
                    page: ordered[0].page,
                    file: ordered[0].file
                });
            });
        });
        return stacks;
    }

    function stackContainsQuery(tokens, qTokens) {
        if (!qTokens.length) return false;
        var left = qTokens.slice();
        (tokens || []).forEach(function (t) {
            var i = left.indexOf(t.norm);
            if (i >= 0) left.splice(i, 1);
        });
        return left.length === 0;
    }

    function stackRestTokens(tokens, qTokens) {
        var qSet = {};
        (qTokens || []).forEach(function (t) { qSet[t] = true; });
        var rest = [];
        var seenTok = {};
        (tokens || []).forEach(function (t) {
            if (qSet[t.norm]) return;
            if (seenTok[t.norm]) return;
            seenTok[t.norm] = true;
            rest.push(t);
        });
        return rest;
    }

    function totalChars(items) {
        return (items || []).reduce(function (n, it) {
            return n + String(it.text || '').length;
        }, 0);
    }

    function findMatches(queries, lines, stacks) {
        var results = [];
        var missing = [];

        (queries || []).forEach(function (rawQuery) {
            var query = String(rawQuery || '').trim();
            var q = normalizeQuery(query);
            if (!q) return;

            var hits = [];
            var seen = {};
            var qTokens = q.split(' ').filter(Boolean);
            var body = qTokens.map(escapeRegex).join('\\s*');
            var pattern = new RegExp(
                '(?<![a-z0-9])' + body + '\\s*' + ID_RE.source + '(?![a-z0-9])',
                'gi'
            );

            function addHit(hit) {
                var key = normalizeQuery(hit.full) + '|' + (hit.file || '') + '|' + (hit.page || 1);
                if (seen[key]) return;
                seen[key] = true;
                hits.push(hit);
            }

            (stacks || []).forEach(function (stack) {
                if (!stackContainsQuery(stack.tokens || [], qTokens)) return;
                var rest = stackRestTokens(stack.tokens || [], qTokens);
                var restText = rest.map(function (t) { return t.text; }).join(' ');
                var full = restText ? query + ' ' + restText : query;
                addHit({
                    full: full,
                    id: restText,
                    page: stack.page,
                    file: stack.file,
                    bbox: stack.bbox || unionItemsBBox(stack.items)
                });
            });

            (lines || []).forEach(function (line) {
                var mapped = normalizeWithMap(line.text);
                if (!mapped.text) return;
                pattern.lastIndex = 0;
                var m;
                while ((m = pattern.exec(mapped.text))) {
                    var id = m[1];
                    var origStart = mapped.map[m.index];
                    var lastIdx = m.index + m[0].length - 1;
                    var origEnd = (mapped.map[lastIdx] != null ? mapped.map[lastIdx] : origStart) + 1;
                    var bbox = unionBBox(line.spans || [], origStart, origEnd);
                    addHit({
                        full: query + ' ' + id,
                        id: id,
                        page: line.page,
                        file: line.file,
                        bbox: bbox
                    });
                }
            });

            results.push({ query: query, hits: hits });
            if (!hits.length) missing.push(query);
        });

        return { results: results, missing: missing };
    }

    root.FloorplanScanner = {
        MIN_TEXT_CHARS: MIN_TEXT_CHARS,
        normalizeQuery: normalizeQuery,
        parseQueries: parseQueries,
        extractPageItems: extractPageItems,
        itemsToLines: itemsToLines,
        itemsToStacks: itemsToStacks,
        totalChars: totalChars,
        findMatches: findMatches
    };
})(typeof window !== 'undefined' ? window : globalThis);
