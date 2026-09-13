(function () {
    'use strict';

    var HANDLE_CURSORS = {
        nw: 'nwse-resize',
        n: 'ns-resize',
        ne: 'nesw-resize',
        e: 'ew-resize',
        se: 'nwse-resize',
        s: 'ns-resize',
        sw: 'nesw-resize',
        w: 'ew-resize',
        move: 'move'
    };

    var selectedFiles = [];
    var lastItems = [];
    var candidates = [];
    var queue = [];
    var lastMissing = [];
    var lastFileCount = 0;
    var lastPreview = null;
    var activeIndex = null;
    var pdfCache = {};
    var focusSeq = 0;
    var cropDrag = null;

    function $(id) {
        return document.getElementById(id);
    }

    function copyBBox(box) {
        if (!box) return null;
        if (window.FloorplanScanner && FloorplanScanner.copyBBox) {
            return FloorplanScanner.copyBBox(box);
        }
        return { x: box.x, y: box.y, w: box.w, h: box.h };
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
        lastItems = [];
        candidates = [];
        queue = [];
        lastMissing = [];
        lastFileCount = 0;
        activeIndex = null;
        cropDrag = null;
        var review = $('scanReviewCard');
        if (review) review.style.display = 'none';
        clearPreview();
        showError('');
        setStatus(false);
        updateCropButtons();
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

    function hideOverlays() {
        if (!lastPreview) return;
        lastPreview.forEach(function (item) {
            if (item.overlayEl) item.overlayEl.style.display = 'none';
        });
    }

    function clearPreview() {
        focusSeq++;
        cropDrag = null;
        var preview = $('scanPdfPreview');
        var host = $('scanPdfPreviewHost');
        if (host) host.innerHTML = '';
        if (preview) preview.style.display = 'none';
        lastPreview = null;
        activeIndex = null;
        clearPdfCache();
    }

    function pendingOnPage(fileName, pageNum) {
        return candidates.filter(function (h, i) {
            if (i === activeIndex) return false;
            if (h.status !== 'pending') return false;
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

    function drawHighlights(canvas, hits, scale, origin) {
        if (!canvas || !hits || !hits.length) return;
        var ctx = canvas.getContext('2d');
        var ox = (origin && origin.x) || 0;
        var oy = (origin && origin.y) || 0;
        var lw = (origin && origin.lineWidth) || 1;
        ctx.save();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255, 193, 7, 0.28)';
        ctx.strokeStyle = 'rgba(200, 150, 0, 0.7)';
        ctx.lineWidth = 1.25 * lw;
        hits.forEach(function (hit) {
            var b = hit.bbox;
            if (!b) return;
            var x = (b.x - ox) * scale;
            var y = (b.y - oy) * scale;
            var w = Math.max(8, b.w * scale);
            var h = Math.max(8, b.h * scale);
            ctx.fillRect(x, y, w, h);
            ctx.strokeRect(x, y, w, h);
        });
        ctx.restore();
    }

    function redrawHighlights(item) {
        if (!item || !item.canvas || !item.pageImage || item.cropped) return;
        var scale = item.previewScale / (item.extractScale || 1);
        item.canvas.getContext('2d').putImageData(item.pageImage, 0, 0);
        drawHighlights(item.canvas, pendingOnPage(item.fileName, item.page), scale);
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

    function copyView(view) {
        if (!view) return null;
        return { left: view.left, top: view.top, worldW: view.worldW, worldH: view.worldH };
    }

    function sameView(a, b) {
        return !!(a && b &&
            a.left === b.left && a.top === b.top &&
            a.worldW === b.worldW && a.worldH === b.worldH);
    }

    function clearWheelZoom(item) {
        if (!item) return;
        if (item.wheelTimer) {
            clearTimeout(item.wheelTimer);
            item.wheelTimer = null;
        }
        item.wheelAnchor = null;
        item.wheelFrac = null;
        item.pendingView = null;
    }

    function restoreOverview(item) {
        if (!item) return;
        clearWheelZoom(item);
        if (item.zoomRenderTask && typeof item.zoomRenderTask.cancel === 'function') {
            try { item.zoomRenderTask.cancel(); } catch (e) { /* ignore */ }
            item.zoomRenderTask = null;
        }
        if (item.cropped && item.overviewCanvas) {
            item.canvas = item.overviewCanvas;
            if (item.zoomEl) {
                item.zoomEl.innerHTML = '';
                item.zoomEl.appendChild(item.overviewCanvas);
            }
            if (item.overlayEl) item.viewportEl.appendChild(item.overlayEl);
            item.cropped = false;
            item.focusView = null;
        }
        resetZoom(item);
    }

    function computeFocusView(item, bbox, vw, vh) {
        var bh = Math.max(8, bbox.h || 0);
        var worldH = bh / 0.18;
        var worldW = worldH * (vw / Math.max(vh, 1));
        if (item && item.pageHeight) worldH = Math.min(worldH, item.pageHeight);
        if (item && item.pageWidth) worldW = Math.min(worldW, Math.max(item.pageWidth, worldH * vw / Math.max(vh, 1)));
        worldW = Math.max(worldW, 24);
        worldH = Math.max(worldH, 24);

        var cx = bbox.x + bbox.w / 2;
        var cy = bbox.y + bbox.h / 2;
        return {
            left: cx - worldW / 2,
            top: cy - worldH / 2,
            worldW: worldW,
            worldH: worldH
        };
    }

    function measureZoomViewport(item) {
        var host = $('scanPdfPreviewHost');
        var vp = item && item.viewportEl;
        var vw = Math.round((host && host.clientWidth) || (vp && vp.clientWidth) || 0);
        var vh = Math.max(240, Math.round(window.innerHeight * 0.55));
        return { vw: vw, vh: vh };
    }

    function pageFitView(item) {
        var size = measureZoomViewport(item);
        var vw = Math.max(size.vw, 1);
        var vh = Math.max(size.vh, 1);
        var pw = item.pageWidth || 1;
        var ph = item.pageHeight || 1;
        var aspect = vw / vh;
        var worldW = pw;
        var worldH = worldW / aspect;
        if (worldH < ph) {
            worldH = ph;
            worldW = worldH * aspect;
        }
        return {
            left: (pw - worldW) / 2,
            top: (ph - worldH) / 2,
            worldW: worldW,
            worldH: worldH
        };
    }

    function clientToPdf(item, clientX, clientY) {
        var canvas = item && item.canvas;
        if (!canvas) return null;
        var rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        if (item.cropped && item.focusView) {
            return {
                x: item.focusView.left + (clientX - rect.left) / rect.width * item.focusView.worldW,
                y: item.focusView.top + (clientY - rect.top) / rect.height * item.focusView.worldH
            };
        }
        var s = item.previewScale / (item.extractScale || 1);
        return {
            x: (clientX - rect.left) / rect.width * canvas.width / s,
            y: (clientY - rect.top) / rect.height * canvas.height / s
        };
    }

    function visiblePdfView(item) {
        if (item.cropped && item.focusView) return copyView(item.focusView);
        var canvas = item.canvas;
        var vp = item.viewportEl;
        if (!canvas || !vp) return pageFitView(item);
        var cRect = canvas.getBoundingClientRect();
        var vRect = vp.getBoundingClientRect();
        if (!cRect.width || !cRect.height) return pageFitView(item);
        var left = Math.max(cRect.left, vRect.left);
        var top = Math.max(cRect.top, vRect.top);
        var right = Math.min(cRect.right, vRect.right);
        var bottom = Math.min(cRect.bottom, vRect.bottom);
        if (right <= left || bottom <= top) return pageFitView(item);
        var tl = clientToPdf(item, left, top);
        var br = clientToPdf(item, right, bottom);
        if (!tl || !br) return pageFitView(item);
        return {
            left: tl.x,
            top: tl.y,
            worldW: Math.max(1, br.x - tl.x),
            worldH: Math.max(1, br.y - tl.y)
        };
    }

    function wheelFactor(e) {
        var notches;
        if (e.deltaMode === 1) notches = e.deltaY;
        else if (e.deltaMode === 2) notches = e.deltaY * 3;
        else notches = e.deltaY / 100;
        var factor = Math.pow(1.15, -notches);
        return Math.min(2, Math.max(0.5, factor));
    }

    function applyWheelZoom(item, e) {
        if (!item || !item.canvas) return;
        var factor = wheelFactor(e);
        if (!item.cropped && !item.pendingView && factor <= 1) return;

        var current = item.pendingView || visiblePdfView(item);
        if (!current || !current.worldW || !current.worldH) return;

        if (!item.wheelAnchor) {
            item.wheelAnchor = clientToPdf(item, e.clientX, e.clientY);
            if (!item.wheelAnchor) return;
            var vRect = item.viewportEl.getBoundingClientRect();
            item.wheelFrac = {
                x: (e.clientX - vRect.left) / Math.max(vRect.width, 1),
                y: (e.clientY - vRect.top) / Math.max(vRect.height, 1)
            };
        }
        var anchor = item.wheelAnchor;
        var fx = item.wheelFrac ? item.wheelFrac.x : 0.5;
        var fy = item.wheelFrac ? item.wheelFrac.y : 0.5;
        if (!isFinite(fx)) fx = 0.5;
        if (!isFinite(fy)) fy = 0.5;

        var size = measureZoomViewport(item);
        var aspect = Math.max(size.vw, 1) / Math.max(size.vh, 1);
        var newH = current.worldH / factor;
        var fit = pageFitView(item);
        if (newH >= fit.worldH - 0.5) {
            restoreOverview(item);
            redrawHighlights(item);
            requestAnimationFrame(syncActiveOverlay);
            return;
        }
        newH = Math.max(24, newH);

        item.pendingView = {
            left: anchor.x - fx * newH * aspect,
            top: anchor.y - fy * newH,
            worldW: newH * aspect,
            worldH: newH
        };
        scheduleZoomRender(item);
    }

    function scheduleZoomRender(item) {
        if (item.wheelTimer) clearTimeout(item.wheelTimer);
        item.wheelTimer = setTimeout(function () {
            item.wheelTimer = null;
            var view = copyView(item.pendingView);
            if (!view) return;
            var token = ++focusSeq;
            paintZoomedView(item, view, token).then(function (ok) {
                if (token !== focusSeq) return;
                if (item.pendingView && !sameView(item.pendingView, view)) {
                    scheduleZoomRender(item);
                    return;
                }
                item.pendingView = null;
                item.wheelAnchor = null;
                item.wheelFrac = null;
                if (ok) syncActiveOverlay();
            });
        }, 120);
    }

    function bindWheelZoom(item) {
        if (!item || !item.viewportEl || item.wheelBound) return;
        item.wheelBound = true;
        item.viewportEl.addEventListener('wheel', function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (cropDrag || document.body.classList.contains('is-cropping')) return;
            applyWheelZoom(item, e);
        }, { passive: false });
    }

    async function paintZoomedView(item, view, token) {
        if (!item || !view || !item.viewportEl) return false;
        var vp = item.viewportEl;
        var size = measureZoomViewport(item);
        var vw = size.vw;
        var vh = size.vh;
        if (!vw || !vh) return false;

        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        var canvasW = Math.max(1, Math.round(vw * dpr));
        var canvasH = Math.max(1, Math.round(vh * dpr));
        var scale = canvasW / view.worldW;
        if (!isFinite(scale) || scale <= 0) return false;

        try {
            var pdf = await getPdf(item.file);
            if (token != null && token !== focusSeq) return false;
            var page = await pdf.getPage(item.page);
            if (token != null && token !== focusSeq) return false;

            if (item.zoomRenderTask && typeof item.zoomRenderTask.cancel === 'function') {
                try { item.zoomRenderTask.cancel(); } catch (e) { /* ignore */ }
                item.zoomRenderTask = null;
            }

            var viewport = page.getViewport({ scale: 1 });
            var canvas = document.createElement('canvas');
            canvas.width = canvasW;
            canvas.height = canvasH;
            canvas.className = 'scan-pdf-preview-canvas';
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvasW, canvasH);

            var task = page.render({
                canvasContext: ctx,
                viewport: viewport,
                transform: [scale, 0, 0, scale, -view.left * scale, -view.top * scale],
                background: '#ffffff'
            });
            item.zoomRenderTask = task;
            await task.promise;
            item.zoomRenderTask = null;
            if (token != null && token !== focusSeq) return false;

            drawHighlights(canvas, pendingOnPage(item.fileName, item.page), scale, {
                x: view.left,
                y: view.top,
                lineWidth: dpr
            });

            if (!item.overviewCanvas && item.canvas) item.overviewCanvas = item.canvas;
            item.canvas = canvas;
            item.cropped = true;
            item.focusView = copyView(view);
            if (item.zoomEl) {
                item.zoomEl.style.transform = '';
                item.zoomEl.innerHTML = '';
                item.zoomEl.appendChild(canvas);
            }
            if (item.overlayEl) item.viewportEl.appendChild(item.overlayEl);
            vp.style.height = Math.round(vh) + 'px';
            vp.classList.add('is-zoomed', 'is-cropped');
            item.zoomed = true;
            return true;
        } catch (err) {
            item.zoomRenderTask = null;
            if (err && (err.name === 'RenderingCancelledException' || /cancel/i.test(err.message || ''))) {
                return false;
            }
            console.error(err);
            restoreOverview(item);
            return false;
        }
    }

    async function paintZoomedCrop(item, bbox, token) {
        if (!item || !bbox || !item.viewportEl) return false;
        var size = measureZoomViewport(item);
        if (!size.vw || !size.vh) return false;
        return paintZoomedView(item, computeFocusView(item, bbox, size.vw, size.vh), token);
    }

    function pdfToViewport(item, box) {
        var canvas = item.canvas;
        var vp = item.viewportEl;
        var cRect = canvas.getBoundingClientRect();
        var vRect = vp.getBoundingClientRect();
        if (item.cropped && item.focusView) {
            var view = item.focusView;
            return {
                left: (cRect.left - vRect.left) + ((box.x - view.left) / view.worldW) * cRect.width,
                top: (cRect.top - vRect.top) + ((box.y - view.top) / view.worldH) * cRect.height,
                w: (box.w / view.worldW) * cRect.width,
                h: (box.h / view.worldH) * cRect.height
            };
        }
        var s = item.previewScale / (item.extractScale || 1);
        return {
            left: (cRect.left - vRect.left) + (box.x * s / canvas.width) * cRect.width,
            top: (cRect.top - vRect.top) + (box.y * s / canvas.height) * cRect.height,
            w: (box.w * s / canvas.width) * cRect.width,
            h: (box.h * s / canvas.height) * cRect.height
        };
    }

    function clientDeltaToPdf(item, dxClient, dyClient) {
        var canvas = item.canvas;
        var rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return { x: 0, y: 0 };
        if (item.cropped && item.focusView) {
            return {
                x: dxClient / rect.width * item.focusView.worldW,
                y: dyClient / rect.height * item.focusView.worldH
            };
        }
        if (!canvas.width) return { x: 0, y: 0 };
        var s = item.previewScale / (item.extractScale || 1);
        return {
            x: dxClient / rect.width * canvas.width / s,
            y: dyClient / rect.height * canvas.height / s
        };
    }

    function clampCrop(box, item) {
        var min = 8;
        var pw = (item && item.pageWidth) || 10000;
        var ph = (item && item.pageHeight) || 10000;
        var x = box.x;
        var y = box.y;
        var w = Math.max(min, box.w);
        var h = Math.max(min, box.h);
        if (w > pw) w = pw;
        if (h > ph) h = ph;
        if (x < 0) x = 0;
        if (y < 0) y = 0;
        if (x + w > pw) x = Math.max(0, pw - w);
        if (y + h > ph) y = Math.max(0, ph - h);
        return { x: x, y: y, w: w, h: h };
    }

    function applyHandle(start, handle, dx, dy) {
        var x1 = start.x;
        var y1 = start.y;
        var x2 = start.x + start.w;
        var y2 = start.y + start.h;
        if (handle === 'move') {
            return { x: start.x + dx, y: start.y + dy, w: start.w, h: start.h };
        }
        if (handle.indexOf('w') >= 0) x1 += dx;
        if (handle.indexOf('e') >= 0) x2 += dx;
        if (handle.indexOf('n') >= 0) y1 += dy;
        if (handle.indexOf('s') >= 0) y2 += dy;
        var x = Math.min(x1, x2);
        var y = Math.min(y1, y2);
        return { x: x, y: y, w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    }

    function syncOverlay(item) {
        if (!item || !item.overlayEl || !item.cropBoxEl || !item.canvas) return;
        if (activeIndex == null || !candidates[activeIndex]) {
            item.overlayEl.style.display = 'none';
            return;
        }
        var cand = candidates[activeIndex];
        if (cand.file !== item.fileName || (cand.page || 1) !== item.page || !cand.crop) {
            item.overlayEl.style.display = 'none';
            return;
        }
        var pos = pdfToViewport(item, cand.crop);
        item.overlayEl.style.display = '';
        item.cropBoxEl.style.left = pos.left + 'px';
        item.cropBoxEl.style.top = pos.top + 'px';
        item.cropBoxEl.style.width = Math.max(4, pos.w) + 'px';
        item.cropBoxEl.style.height = Math.max(4, pos.h) + 'px';
    }

    function syncActiveOverlay() {
        if (!lastPreview || activeIndex == null) {
            hideOverlays();
            return;
        }
        var cand = candidates[activeIndex];
        lastPreview.forEach(function (item) {
            if (cand && item.fileName === cand.file) syncOverlay(item);
            else if (item.overlayEl) item.overlayEl.style.display = 'none';
        });
    }

    function onCropMove(e) {
        if (!cropDrag || activeIndex == null) return;
        var cand = candidates[activeIndex];
        var item = cropDrag.item;
        if (!cand || !item) return;
        var d = clientDeltaToPdf(item, e.clientX - cropDrag.startX, e.clientY - cropDrag.startY);
        cand.crop = clampCrop(applyHandle(cropDrag.startBox, cropDrag.handle, d.x, d.y), item);
        syncOverlay(item);
    }

    function endCropDrag(e) {
        if (!cropDrag) return;
        if (e && cropDrag.item && cropDrag.item.cropBoxEl && e.pointerId != null) {
            try { cropDrag.item.cropBoxEl.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        }
        cropDrag = null;
        document.body.classList.remove('is-cropping');
    }

    function bindCropPointer(item) {
        var box = item.cropBoxEl;
        box.addEventListener('pointerdown', function (e) {
            if (activeIndex == null) return;
            var cand = candidates[activeIndex];
            if (!cand || !cand.crop) return;
            e.preventDefault();
            e.stopPropagation();
            var handle = e.target.getAttribute('data-handle') || 'move';
            box.setPointerCapture(e.pointerId);
            document.body.classList.add('is-cropping');
            cropDrag = {
                item: item,
                handle: handle,
                startX: e.clientX,
                startY: e.clientY,
                startBox: copyBBox(cand.crop)
            };
        });
        box.addEventListener('pointermove', function (e) {
            if (!cropDrag || cropDrag.item !== item) return;
            onCropMove(e);
        });
        box.addEventListener('pointerup', endCropDrag);
        box.addEventListener('pointercancel', endCropDrag);
    }

    function createOverlay(item) {
        var overlay = document.createElement('div');
        overlay.className = 'crop-overlay';
        overlay.style.display = 'none';
        var box = document.createElement('div');
        box.className = 'crop-box';
        ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(function (h) {
            var el = document.createElement('div');
            el.className = 'crop-handle crop-handle-' + h;
            el.setAttribute('data-handle', h);
            el.style.cursor = HANDLE_CURSORS[h];
            box.appendChild(el);
        });
        overlay.appendChild(box);
        item.viewportEl.appendChild(overlay);
        item.overlayEl = overlay;
        item.cropBoxEl = box;
        bindCropPointer(item);
    }

    async function paintPreviewPage(item, pageNum) {
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
        item.focusView = null;
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
        if (!item.overlayEl) createOverlay(item);
        else item.viewportEl.appendChild(item.overlayEl);

        var scale = previewScale / (item.extractScale || 1);
        drawHighlights(canvas, pendingOnPage(item.fileName, pageNum), scale);
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
            overlayEl: null,
            cropBoxEl: null,
            label: label,
            page: pageNum,
            previewScale: 1,
            extractScale: extractScale,
            pageImage: null,
            overviewCanvas: null,
            cropped: false,
            focusView: null,
            zoomRenderTask: null,
            pageWidth: 0,
            pageHeight: 0,
            zoomed: false,
            wheelTimer: null,
            wheelAnchor: null,
            wheelFrac: null,
            pendingView: null,
            wheelBound: false
        };
        bindWheelZoom(item);
        await paintPreviewPage(item, pageNum);
        return item;
    }

    function nextFrame() {
        return new Promise(function (resolve) {
            requestAnimationFrame(function () { resolve(); });
        });
    }

    function updateSelectedRow() {
        ['foundList', 'queueList'].forEach(function (id) {
            var host = $(id);
            if (!host) return;
            var rows = host.querySelectorAll('[data-hit-index]');
            for (var i = 0; i < rows.length; i++) {
                var row = rows[i];
                var on = Number(row.getAttribute('data-hit-index')) === activeIndex;
                row.classList.toggle('is-selected', on);
                row.setAttribute('aria-pressed', on ? 'true' : 'false');
            }
        });
    }

    function updateCropButtons() {
        var has = activeIndex != null && !!candidates[activeIndex];
        var accept = $('cropAcceptBtn');
        var skip = $('cropSkipBtn');
        var prev = $('cropPrevBtn');
        if (accept) accept.disabled = !has;
        if (skip) skip.disabled = !has;
        if (prev) prev.disabled = !has || activeIndex <= 0;
    }

    function showOverview() {
        if (!lastPreview) return;
        lastPreview.forEach(function (item) {
            restoreOverview(item);
            redrawHighlights(item);
        });
        requestAnimationFrame(syncActiveOverlay);
    }

    async function focusHit(index) {
        if (index < 0 || index >= candidates.length) return;

        activeIndex = index;
        updateSelectedRow();
        updateCropButtons();

        var hit = candidates[index];
        var item = findPreviewItem(hit.file);
        if (!item) return;

        var token = ++focusSeq;
        var pageNum = hit.page || 1;

        if (lastPreview) {
            lastPreview.forEach(function (other) {
                if (other !== item) restoreOverview(other);
            });
        }

        if (item.cropped) restoreOverview(item);

        if (item.page !== pageNum || !item.pageImage) {
            await paintPreviewPage(item, pageNum);
            if (token !== focusSeq) return;
        } else {
            redrawHighlights(item);
        }

        var previewCard = $('scanPdfPreview');
        if (previewCard) previewCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (item.wrap) item.wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        await nextFrame();
        if (token !== focusSeq) return;
        var size = measureZoomViewport(item);
        if (!size.vw) {
            await nextFrame();
            if (token !== focusSeq) return;
        }
        var box = hit.bbox || hit.crop;
        if (box) {
            var sharp = await paintZoomedCrop(item, box, token);
            if (token !== focusSeq) return;
            if (!sharp) {
                await nextFrame();
                if (token !== focusSeq) return;
                sharp = await paintZoomedCrop(item, box, token);
                if (token !== focusSeq) return;
            }
            if (!sharp) restoreOverview(item);
        }
        await nextFrame();
        if (token !== focusSeq) return;
        syncActiveOverlay();
    }

    function nextPending(from) {
        var i;
        for (i = from + 1; i < candidates.length; i++) {
            if (candidates[i].status === 'pending') return i;
        }
        for (i = 0; i < candidates.length; i++) {
            if (candidates[i].status === 'pending') return i;
        }
        return -1;
    }

    function acceptCrop() {
        if (activeIndex == null || !candidates[activeIndex]) return;
        var cand = candidates[activeIndex];
        var crop = cand.crop || cand.bbox;
        var text = window.FloorplanScanner && FloorplanScanner.textsInCrop
            ? FloorplanScanner.textsInCrop(lastItems, crop, cand.file, cand.page || 1)
            : '';
        if (!text) text = cand.query || '';
        cand.status = 'accepted';
        cand.full = text;
        cand.crop = copyBBox(crop);
        queue = queue.filter(function (q) { return q.candidateIndex !== activeIndex; });
        queue.push({
            candidateIndex: activeIndex,
            full: text,
            file: cand.file,
            page: cand.page || 1,
            bbox: copyBBox(crop),
            query: cand.query
        });
        renderReview();
        var next = nextPending(activeIndex);
        if (next >= 0) focusHit(next);
        else {
            showOverview();
            updateCropButtons();
        }
    }

    function skipCrop() {
        if (activeIndex == null || !candidates[activeIndex]) return;
        var cand = candidates[activeIndex];
        cand.status = 'skipped';
        queue = queue.filter(function (q) { return q.candidateIndex !== activeIndex; });
        renderReview();
        var next = nextPending(activeIndex);
        if (next >= 0) focusHit(next);
        else {
            showOverview();
            updateCropButtons();
        }
    }

    function prevCrop() {
        if (activeIndex == null || activeIndex <= 0) return;
        focusHit(activeIndex - 1);
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
        lastItems = [];
        candidates = [];
        queue = [];
        lastMissing = [];
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
            var found = FS.findMatches(queries, allItems);
            lastItems = allItems;
            lastMissing = found.missing || [];
            lastFileCount = selectedFiles.length;

            candidates = [];
            found.results.forEach(function (r) {
                r.hits.forEach(function (h) {
                    candidates.push({
                        query: h.query,
                        full: h.full || h.query,
                        page: h.page || 1,
                        file: h.file,
                        bbox: copyBBox(h.bbox),
                        crop: copyBBox(h.bbox),
                        status: 'pending'
                    });
                });
            });
            candidates.sort(function (a, b) {
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

            renderReview();
            setStatus(false);
            if (warnings.length) {
                showError(warnings.join(' · '));
            }
            if (candidates.length) {
                await focusHit(0);
            } else {
                updateCropButtons();
            }
        } catch (err) {
            console.error(err);
            setStatus(false);
            showError('Skannaus epäonnistui: ' + ((err && err.message) || err));
        }
    }

    function resultRowHtml(text, meta, index, selected) {
        var hitAttr = index == null ? '' :
            ' role="button" tabindex="0" data-hit-index="' + index +
            '" aria-pressed="' + (selected ? 'true' : 'false') + '"';
        var cls = 'result-row' + (index != null ? ' result-row-hit' : '') + (selected ? ' is-selected' : '');
        return '<div class="' + cls + '"' + hitAttr + '>' +
            '<span class="result-text">' + escapeHtml(text) + '</span>' +
            '<span class="result-meta">' + escapeHtml(meta) + '</span></div>';
    }

    function renderReview() {
        var pending = [];
        candidates.forEach(function (h, i) {
            if (h.status === 'pending') pending.push(i);
        });

        $('scanSummaryBadge').textContent =
            pending.length + ' käsittelemättä · ' + queue.length + ' hyväksytty · ' +
            lastMissing.length + ' puuttuu · ' +
            lastFileCount + (lastFileCount === 1 ? ' PDF' : ' PDF:ää');

        var foundHost = $('foundList');
        var pendingWrap = $('pendingSection');
        if (!pending.length) {
            foundHost.innerHTML = candidates.length
                ? '<div class="result-empty">Kaikki osumat käsitelty.</div>'
                : '<div class="result-empty">Ei osumia.</div>';
        } else {
            foundHost.innerHTML = pending.map(function (i) {
                var h = candidates[i];
                var meta = (h.file || '') + ' · s. ' + (h.page || 1);
                return resultRowHtml(h.query || h.full, meta, i, i === activeIndex);
            }).join('');
        }
        if (pendingWrap) pendingWrap.style.display = '';

        var queueHost = $('queueList');
        var queueWrap = $('queueSection');
        if (!queue.length) {
            queueHost.innerHTML = '<div class="result-empty">Ei hyväksyttyjä rajauksia.</div>';
        } else {
            queueHost.innerHTML = queue.map(function (q) {
                var meta = (q.file || '') + ' · s. ' + (q.page || 1);
                return resultRowHtml(q.full, meta, q.candidateIndex, q.candidateIndex === activeIndex);
            }).join('');
        }
        if (queueWrap) queueWrap.style.display = '';

        var missingWrap = $('missingSection');
        var missingHost = $('missingList');
        if (!lastMissing.length) {
            missingWrap.style.display = 'none';
            missingHost.innerHTML = '';
        } else {
            missingWrap.style.display = '';
            missingHost.innerHTML = lastMissing.map(function (q) {
                return '<div class="result-row"><span class="result-text">' + escapeHtml(q) + '</span></div>';
            }).join('');
        }

        $('scanReviewCard').style.display = '';
        updateCropButtons();
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

    function bindResultLists() {
        function onActivate(e) {
            var row = e.target.closest('[data-hit-index]');
            if (!row) return;
            if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
            if (e.type === 'keydown') e.preventDefault();
            focusHit(Number(row.getAttribute('data-hit-index')));
        }
        ['foundList', 'queueList'].forEach(function (id) {
            var host = $(id);
            if (!host || host.dataset.bound) return;
            host.addEventListener('click', onActivate);
            host.addEventListener('keydown', onActivate);
            host.dataset.bound = '1';
        });
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
        bindResultLists();
        $('scanBtn').addEventListener('click', runScan);
        $('clearBtn').addEventListener('click', clearAll);
        $('copyLinesBtn').addEventListener('click', function () {
            var lines = queue.map(function (q) { return q.full; }).filter(Boolean);
            copyText(lines.join('\n'), $('copyLinesBtn'));
        });
        var resetBtn = $('previewResetBtn');
        if (resetBtn) resetBtn.addEventListener('click', showOverview);
        var acceptBtn = $('cropAcceptBtn');
        if (acceptBtn) acceptBtn.addEventListener('click', acceptCrop);
        var skipBtn = $('cropSkipBtn');
        if (skipBtn) skipBtn.addEventListener('click', skipCrop);
        var prevBtn = $('cropPrevBtn');
        if (prevBtn) prevBtn.addEventListener('click', prevCrop);
        window.addEventListener('resize', function () {
            requestAnimationFrame(syncActiveOverlay);
        });
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
        updateCropButtons();
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
