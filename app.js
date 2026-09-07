(function () {
    'use strict';

    var selectedFiles = [];
    var lastFoundLines = [];
    var lastHits = [];
    var lastPreview = null;
    var selectedHitIndex = null;
    var pdfCache = {};
    var focusSeq = 0;

    function $(id) {
        return document.getElementById(id);
    }

    function setStatus(on, text, pct) {
        var el = $('scannerStatus');
        if (!el) return;
        el.style.display = on ? '' : 'none';
        if (text) $('scannerStatusText').textContent = text;
        var bar = $('scannerProgressBar');
        if (bar && pct != null) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    }

    function showError(msg) {
        var el = $('scannerError');
        if (!el) return;
        if (!msg) {
            el.style.display = 'none';
            el.textContent = '';
            return;
        }
        el.style.display = '';
        el.textContent = msg;
    }

    function renderFileList() {
        var host = $('scannerFileList');
        if (!host) return;
        if (!selectedFiles.length) {
            host.style.display = 'none';
            host.innerHTML = '';
            return;
        }
        host.style.display = '';
        host.innerHTML = selectedFiles.map(function (f, i) {
            return '<span class="scanner-file-chip">' +
                '<span class="scanner-file-chip-name">' + escapeHtml(f.name) + '</span>' +
                '<button type="button" class="scanner-file-chip-remove" data-index="' + i +
                '" aria-label="Poista ' + escapeHtml(f.name) + '">×</button>' +
                '</span>';
        }).join('');
    }

    function resetScanUi() {
        lastFoundLines = [];
        lastHits = [];
        selectedHitIndex = null;
        var review = $('scanReviewCard');
        if (review) review.style.display = 'none';
        clearPreview();
        showError('');
        setStatus(false);
    }

    function removeFile(index) {
        if (index < 0 || index >= selectedFiles.length) return;
        selectedFiles.splice(index, 1);
        var fi = $('scannerFileInput');
        if (fi) fi.value = '';
        renderFileList();
        resetScanUi();
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function fileKey(f) {
        return (f.name || '') + '|' + (f.size || 0) + '|' + (f.lastModified || 0);
    }

    function takePdfs(fileList) {
        var pdfs = Array.from(fileList || []).filter(function (f) {
            return f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''));
        });
        if (!pdfs.length) return pdfs;

        var seen = {};
        selectedFiles.forEach(function (f) {
            seen[fileKey(f)] = true;
        });
        pdfs.forEach(function (f) {
            var key = fileKey(f);
            if (seen[key]) return;
            seen[key] = true;
            selectedFiles.push(f);
        });

        var input = $('scannerFileInput');
        if (input) input.value = '';

        renderFileList();
        resetScanUi();
        return pdfs;
    }

    function clearPdfCache() {
        Object.keys(pdfCache).forEach(function (key) {
            var doc = pdfCache[key];
            if (doc && typeof doc.destroy === 'function') {
                try { doc.destroy(); } catch (e) { /* ignore */ }
            }
        });
        pdfCache = {};
    }

    async function getPdf(file) {
        var key = fileKey(file);
        if (!pdfCache[key]) {
            pdfCache[key] = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
        }
        return pdfCache[key];
    }

    function clearPreview() {
        focusSeq++;
        var preview = $('scanPdfPreview');
        var host = $('scanPdfPreviewHost');
        if (host) host.innerHTML = '';
        if (preview) preview.style.display = 'none';
        lastPreview = null;
        selectedHitIndex = null;
        clearPdfCache();
    }

    function hitsOnPage(fileName, pageNum) {
        return lastHits.filter(function (h) {
            return h.file === fileName && (h.page || 1) === pageNum;
        });
    }

    function findPreviewItem(fileName) {
        if (!lastPreview) return null;
        for (var i = 0; i < lastPreview.length; i++) {
            if (lastPreview[i].fileName === fileName) return lastPreview[i];
        }
        return lastPreview[0] || null;
    }

    function drawHighlights(canvas, hits, scale, selectedHit, origin) {
        if (!canvas || !hits || !hits.length) return;
        var ctx = canvas.getContext('2d');
        var ox = (origin && origin.x) || 0;
        var oy = (origin && origin.y) || 0;
        var lw = (origin && origin.lineWidth) || 1;
        var zoomStyle = !!(origin && origin.zoomStyle);
        ctx.save();
        function paint(hit, selected) {
            var b = hit.bbox;
            if (!b) return;
            var x = (b.x - ox) * scale;
            var y = (b.y - oy) * scale;
            var w = Math.max(8, b.w * scale);
            var h = Math.max(8, b.h * scale);
            if (zoomStyle) {
                if (!selected) return;
                ctx.setLineDash([5 * lw, 4 * lw]);
                ctx.strokeStyle = '#b71c1c';
                ctx.lineWidth = Math.max(1, 1.15 * 1.7 * lw);
                ctx.strokeRect(x, y, w, h);
                return;
            }
            ctx.setLineDash([]);
            ctx.fillStyle = selected ? 'rgba(255, 120, 0, 0.45)' : 'rgba(255, 193, 7, 0.38)';
            ctx.strokeStyle = selected ? 'rgba(220, 80, 0, 1)' : 'rgba(200, 150, 0, 0.9)';
            ctx.lineWidth = (selected ? 3 : 1.5) * lw;
            ctx.fillRect(x, y, w, h);
            ctx.strokeRect(x, y, w, h);
        }
        if (zoomStyle) {
            if (selectedHit) paint(selectedHit, true);
            ctx.restore();
            return;
        }
        hits.forEach(function (hit) {
            if (hit !== selectedHit) paint(hit, false);
        });
        if (selectedHit) paint(selectedHit, true);
        ctx.restore();
    }

    function redrawHighlights(item, selectedHit) {
        if (!item || !item.canvas || !item.pageImage || item.cropped) return;
        var scale = item.previewScale / (item.extractScale || 1);
        item.canvas.getContext('2d').putImageData(item.pageImage, 0, 0);
        drawHighlights(item.canvas, hitsOnPage(item.fileName, item.page), scale, selectedHit);
    }

    function resetZoom(item) {
        if (!item) return;
        item.zoomed = false;
        if (item.zoomEl) item.zoomEl.style.transform = '';
        if (item.viewportEl) {
            item.viewportEl.classList.remove('is-zoomed', 'is-cropped');
            item.viewportEl.style.height = '';
        }
    }

    function restoreOverview(item) {
        if (!item) return;
        if (item.cropped && item.overviewCanvas) {
            item.canvas = item.overviewCanvas;
            if (item.zoomEl) {
                item.zoomEl.innerHTML = '';
                item.zoomEl.appendChild(item.overviewCanvas);
            }
            item.cropped = false;
        }
        resetZoom(item);
    }

    function computeFocusView(item, bbox, vw, vh) {
        var bw = Math.max(8, bbox.w);
        var bh = Math.max(8, bbox.h);
        var worldW = bw * 4;
        var worldH = bh * 4;
        var aspect = vw / vh;
        if (worldW / worldH < aspect) worldW = worldH * aspect;
        else worldH = worldW / aspect;

        var cx = bbox.x + bbox.w / 2;
        var cy = bbox.y + bbox.h / 2;
        return {
            left: cx - worldW / 2,
            top: cy - worldH / 2,
            worldW: worldW,
            worldH: worldH
        };
    }

    function zoomToBbox(item, bbox) {
        if (!item || !item.canvas || !item.viewportEl || !item.zoomEl || !bbox) {
            resetZoom(item);
            return false;
        }

        resetZoom(item);

        var canvas = item.canvas;
        var vp = item.viewportEl;
        var vpRect = vp.getBoundingClientRect();
        var canvasRect = canvas.getBoundingClientRect();
        var vw = vpRect.width;
        var vh = vpRect.height;
        if (!vw || !vh || !canvas.width || !canvasRect.width) return false;

        var view = computeFocusView(item, bbox, vw, vh);
        var cssScale = canvasRect.width / canvas.width;
        var s = item.previewScale / (item.extractScale || 1);
        var dispW = view.worldW * s * cssScale;
        var zoom = dispW > 0 ? vw / dispW : 1;
        zoom = Math.max(1, Math.min(40, zoom));
        if (zoom <= 1.05) return false;

        var viewCx = view.left + view.worldW / 2;
        var viewCy = view.top + view.worldH / 2;
        var cx = (canvasRect.left - vpRect.left) + viewCx * s * cssScale;
        var cy = (canvasRect.top - vpRect.top) + viewCy * s * cssScale;
        var tx = vw / 2 - cx * zoom;
        var ty = vh / 2 - cy * zoom;

        vp.style.height = Math.round(vh) + 'px';
        item.zoomEl.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + zoom + ')';
        item.viewportEl.classList.add('is-zoomed');
        item.zoomed = true;
        return true;
    }

    async function paintZoomedCrop(item, hit, token) {
        if (!item || !hit || !hit.bbox || !item.viewportEl) return;
        var vp = item.viewportEl;
        var vw = vp.clientWidth;
        var vh = vp.clientHeight;
        if (!vw || !vh) return;

        var view = computeFocusView(item, hit.bbox, vw, vh);
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        var canvasW = Math.max(1, Math.round(vw * dpr));
        var canvasH = Math.max(1, Math.round(vh * dpr));
        var scale = canvasW / view.worldW;

        var pdf = await getPdf(item.file);
        if (token != null && token !== focusSeq) return;
        var page = await pdf.getPage(item.page);
        if (token != null && token !== focusSeq) return;
        var viewport = page.getViewport({ scale: scale });
        var canvas = document.createElement('canvas');
        canvas.width = canvasW;
        canvas.height = canvasH;
        canvas.className = 'scan-pdf-preview-canvas';
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvasW, canvasH);
        await page.render({
            canvasContext: ctx,
            viewport: viewport,
            transform: [1, 0, 0, 1, -view.left * scale, -view.top * scale],
            background: '#ffffff'
        }).promise;
        if (token != null && token !== focusSeq) return;

        drawHighlights(canvas, [hit], scale, hit, {
            x: view.left,
            y: view.top,
            lineWidth: dpr,
            zoomStyle: true
        });

        if (!item.overviewCanvas && item.canvas) item.overviewCanvas = item.canvas;
        item.canvas = canvas;
        item.cropped = true;
        if (item.zoomEl) {
            item.zoomEl.style.transform = '';
            item.zoomEl.innerHTML = '';
            item.zoomEl.appendChild(canvas);
        }
        vp.style.height = Math.round(vh) + 'px';
        vp.classList.add('is-zoomed', 'is-cropped');
        item.zoomed = true;
    }

    async function paintPreviewPage(item, pageNum, selectedHit) {
        var pdf = await getPdf(item.file);
        var page = await pdf.getPage(pageNum);
        var base = page.getViewport({ scale: 1 });
        var previewScale = Math.min(2.2, Math.max(0.8, 1400 / base.width));
        var viewport = page.getViewport({ scale: previewScale });
        var canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.className = 'scan-pdf-preview-canvas';
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;

        var pageImage = null;
        try {
            pageImage = ctx.getImageData(0, 0, canvas.width, canvas.height);
        } catch (e) {
            pageImage = null;
        }

        item.previewScale = previewScale;
        item.page = pageNum;
        item.pageWidth = base.width;
        item.pageHeight = base.height;
        item.canvas = canvas;
        item.overviewCanvas = canvas;
        item.cropped = false;
        item.pageImage = pageImage;
        item.label.textContent = item.fileName + ' · s. ' + pageNum;

        if (!item.zoomEl) {
            item.zoomEl = document.createElement('div');
            item.zoomEl.className = 'scan-pdf-preview-zoom';
            item.viewportEl.appendChild(item.zoomEl);
        }
        item.zoomEl.innerHTML = '';
        item.zoomEl.appendChild(canvas);
        resetZoom(item);

        var scale = previewScale / (item.extractScale || 1);
        drawHighlights(canvas, hitsOnPage(item.fileName, pageNum), scale, selectedHit);
    }

    async function createPreviewItem(file, extractScale, pageNum) {
        var wrap = document.createElement('div');
        wrap.className = 'scan-pdf-preview-item';
        var label = document.createElement('div');
        label.className = 'scan-pdf-preview-name';
        var viewportEl = document.createElement('div');
        viewportEl.className = 'scan-pdf-preview-viewport';
        wrap.appendChild(label);
        wrap.appendChild(viewportEl);

        var item = {
            fileName: file.name,
            file: file,
            wrap: wrap,
            canvas: null,
            viewportEl: viewportEl,
            zoomEl: null,
            label: label,
            page: pageNum,
            previewScale: 1,
            extractScale: extractScale,
            pageImage: null,
            overviewCanvas: null,
            cropped: false,
            pageWidth: 0,
            pageHeight: 0,
            zoomed: false
        };
        await paintPreviewPage(item, pageNum, null);
        return item;
    }

    function updateSelectedRow() {
        var host = $('foundList');
        if (!host) return;
        var rows = host.querySelectorAll('[data-hit-index]');
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var on = Number(row.getAttribute('data-hit-index')) === selectedHitIndex;
            row.classList.toggle('is-selected', on);
            row.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
    }

    function resetPreviewFocus() {
        selectedHitIndex = null;
        updateSelectedRow();
        if (!lastPreview) return;
        lastPreview.forEach(function (item) {
            restoreOverview(item);
            redrawHighlights(item, null);
        });
    }

    async function focusHit(index) {
        if (index < 0 || index >= lastHits.length) return;
        if (selectedHitIndex === index) {
            resetPreviewFocus();
            return;
        }

        selectedHitIndex = index;
        updateSelectedRow();

        var hit = lastHits[index];
        var item = findPreviewItem(hit.file);
        if (!item) return;

        var token = ++focusSeq;
        var pageNum = hit.page || 1;
        var selectedHit = hit;

        if (lastPreview) {
            lastPreview.forEach(function (other) {
                if (other !== item) restoreOverview(other);
            });
        }

        if (item.cropped) restoreOverview(item);

        if (item.page !== pageNum || !item.pageImage) {
            await paintPreviewPage(item, pageNum, hit.bbox ? null : selectedHit);
            if (token !== focusSeq) return;
        } else if (!hit.bbox) {
            redrawHighlights(item, selectedHit);
        }

        if (hit.bbox && item.pageImage && item.canvas && !item.cropped) {
            item.canvas.getContext('2d').putImageData(item.pageImage, 0, 0);
        }

        var previewCard = $('scanPdfPreview');
        if (previewCard) previewCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (item.wrap) item.wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        requestAnimationFrame(function () {
            if (token !== focusSeq) return;
            if (!hit.bbox) {
                restoreOverview(item);
                return;
            }
            var didZoom = zoomToBbox(item, hit.bbox);
            if (!didZoom) {
                redrawHighlights(item, selectedHit);
                return;
            }
            paintZoomedCrop(item, hit, token).catch(function (err) {
                console.error(err);
            });
        });
    }

    async function extractFile(file, extractScale) {
        var pdf = await getPdf(file);
        var items = [];
        for (var p = 1; p <= pdf.numPages; p++) {
            var page = await pdf.getPage(p);
            var viewport = page.getViewport({ scale: extractScale });
            var tc = await page.getTextContent();
            var pageItems = FloorplanScanner.extractPageItems(tc, viewport, p, file.name);
            items = items.concat(pageItems);
        }
        return items;
    }

    async function runScan() {
        var FS = window.FloorplanScanner;
        if (!FS) {
            showError('Hakumoottori ei latautunut. Päivitä sivu.');
            return;
        }
        if (!window.pdfjsLib) {
            showError('PDF-kirjasto ei latautunut. Tarkista verkkoyhteys ja päivitä sivu.');
            return;
        }

        var queries = FS.parseQueries($('nameListInput').value);
        if (!queries.length) {
            showError('Syötä vähintään yksi tuotekoodi nimilistaan.');
            return;
        }
        if (!selectedFiles.length) {
            showError('Lataa vähintään yksi vektori-PDF.');
            return;
        }

        showError('');
        $('scanReviewCard').style.display = 'none';
        clearPreview();
        setStatus(true, 'Avataan PDF…', 5);

        var extractScale = 1;
        var allItems = [];
        var warnings = [];

        try {
            for (var i = 0; i < selectedFiles.length; i++) {
                var file = selectedFiles[i];
                var pct = 8 + Math.round((i / selectedFiles.length) * 70);
                setStatus(true, 'Luetaan ' + file.name + ' (' + (i + 1) + '/' + selectedFiles.length + ')…', pct);
                var items = await extractFile(file, extractScale);
                if (FS.totalChars(items) < FS.MIN_TEXT_CHARS) {
                    warnings.push(file.name + ': ei tekstikerrosta');
                } else {
                    allItems = allItems.concat(items);
                }
            }

            if (FS.totalChars(allItems) < FS.MIN_TEXT_CHARS) {
                setStatus(false);
                showError('Ei tekstikerrosta — tämä skanneri tukee vain vektori-PDF:iä.');
                return;
            }

            setStatus(true, 'Etsitään koodeja…', 88);
            var lines = FS.itemsToLines(allItems);
            var stacks = FS.itemsToStacks(allItems);
            var found = FS.findMatches(queries, lines, stacks);

            lastHits = [];
            found.results.forEach(function (r) {
                r.hits.forEach(function (h) {
                    lastHits.push(h);
                });
            });

            setStatus(true, 'Piirretään esikatselu…', 94);
            var host = $('scanPdfPreviewHost');
            var preview = $('scanPdfPreview');
            if (host && preview) {
                host.innerHTML = '';
                var rendered = [];
                for (var p = 0; p < selectedFiles.length; p++) {
                    var item = await createPreviewItem(selectedFiles[p], extractScale, 1);
                    host.appendChild(item.wrap);
                    rendered.push(item);
                }
                preview.style.display = '';
                lastPreview = rendered;
            }

            renderResults(found, selectedFiles.length);
            setStatus(false);
            if (warnings.length) {
                showError(warnings.join(' · '));
            }
        } catch (err) {
            console.error(err);
            setStatus(false);
            showError('Skannaus epäonnistui: ' + ((err && err.message) || err));
        }
    }

    function renderResults(found, fileCount) {
        lastFoundLines = lastHits.map(function (h) { return h.full; });
        var hitCount = lastHits.length;

        $('scanSummaryBadge').textContent =
            hitCount + ' osumaa · ' + found.missing.length + ' puuttuu · ' +
            fileCount + (fileCount === 1 ? ' PDF' : ' PDF:ää');

        var foundHost = $('foundList');
        if (!hitCount) {
            foundHost.innerHTML = '<div class="result-empty">Ei osumia.</div>';
        } else {
            foundHost.innerHTML = lastHits.map(function (h, i) {
                var meta = escapeHtml(h.file || '') + ' · s. ' + (h.page || 1);
                return '<div class="result-row result-row-hit" role="button" tabindex="0" data-hit-index="' +
                    i + '" aria-pressed="false"><span class="result-text">' +
                    escapeHtml(h.full) + '</span> <span class="result-meta">' + meta + '</span></div>';
            }).join('');
        }

        var missingWrap = $('missingSection');
        var missingHost = $('missingList');
        if (!found.missing.length) {
            missingWrap.style.display = 'none';
            missingHost.innerHTML = '';
        } else {
            missingWrap.style.display = '';
            missingHost.innerHTML = found.missing.map(function (q) {
                return '<div class="result-row"><span class="result-text">' + escapeHtml(q) + '</span></div>';
            }).join('');
        }

        $('scanReviewCard').style.display = '';
    }

    async function copyText(text, btn) {
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            if (btn) {
                var prev = btn.textContent;
                btn.textContent = 'Kopioitu';
                setTimeout(function () { btn.textContent = prev; }, 1200);
            }
        } catch (e) {
            showError('Kopiointi epäonnistui.');
        }
    }

    function bindDropzone() {
        var dz = $('scannerDropZone');
        var input = $('scannerFileInput');
        if (!dz || !input) return;

        dz.addEventListener('click', function () { input.click(); });
        dz.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                input.click();
            }
        });
        input.addEventListener('change', function (e) {
            var incoming = Array.from(e.target.files || []);
            var pdfs = takePdfs(incoming);
            if (incoming.length && !pdfs.length) showError('Valitse PDF-tiedosto.');
        });
        ['dragover', 'dragenter'].forEach(function (ev) {
            dz.addEventListener(ev, function (e) {
                e.preventDefault();
                dz.classList.add('dragover');
            });
        });
        ['dragleave', 'dragend'].forEach(function (ev) {
            dz.addEventListener(ev, function (e) {
                e.preventDefault();
                dz.classList.remove('dragover');
            });
        });
        function onDrop(e) {
            e.preventDefault();
            dz.classList.remove('dragover');
            var incoming = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
            var pdfs = takePdfs(incoming);
            if (incoming.length && !pdfs.length) showError('Valitse PDF-tiedosto.');
        }
        dz.addEventListener('drop', onDrop);
        var fileList = $('scannerFileList');
        if (fileList) {
            ['dragover', 'dragenter'].forEach(function (ev) {
                fileList.addEventListener(ev, function (e) {
                    e.preventDefault();
                    dz.classList.add('dragover');
                });
            });
            fileList.addEventListener('drop', onDrop);
        }
    }

    function bindFoundList() {
        var foundHost = $('foundList');
        if (!foundHost || foundHost.dataset.bound) return;
        foundHost.addEventListener('click', function (e) {
            var row = e.target.closest('[data-hit-index]');
            if (!row) return;
            focusHit(Number(row.getAttribute('data-hit-index')));
        });
        foundHost.addEventListener('keydown', function (e) {
            var row = e.target.closest('[data-hit-index]');
            if (!row) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                focusHit(Number(row.getAttribute('data-hit-index')));
            }
        });
        foundHost.dataset.bound = '1';
    }

    function clearAll() {
        selectedFiles = [];
        $('nameListInput').value = '';
        $('scannerFileInput').value = '';
        renderFileList();
        resetScanUi();
    }

    function init() {
        bindDropzone();
        bindFoundList();
        $('scanBtn').addEventListener('click', runScan);
        $('clearBtn').addEventListener('click', clearAll);
        $('copyLinesBtn').addEventListener('click', function () {
            copyText(lastFoundLines.join('\n'), $('copyLinesBtn'));
        });
        var resetBtn = $('previewResetBtn');
        if (resetBtn) {
            resetBtn.addEventListener('click', resetPreviewFocus);
        }
        var fileList = $('scannerFileList');
        if (fileList && !fileList.dataset.bound) {
            fileList.addEventListener('click', function (e) {
                var btn = e.target.closest('.scanner-file-chip-remove');
                if (!btn) return;
                e.preventDefault();
                e.stopPropagation();
                removeFile(Number(btn.getAttribute('data-index')));
            });
            fileList.dataset.bound = '1';
        }
    }

    window.fpScanApp = {
        setFiles: function (files) {
            selectedFiles = Array.from(files || []);
            renderFileList();
        },
        getFiles: function () {
            return selectedFiles.slice();
        },
        runScan: runScan
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
