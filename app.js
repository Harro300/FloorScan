(function () {
    'use strict';

    var selectedFiles = [];
    var lastFoundLines = [];
    var lastPreview = null;

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

    function removeFile(index) {
        if (index < 0 || index >= selectedFiles.length) return;
        selectedFiles.splice(index, 1);
        var fi = $('scannerFileInput');
        if (fi) fi.value = '';
        renderFileList();
        lastFoundLines = [];
        var review = $('scanReviewCard');
        if (review) review.style.display = 'none';
        clearPreview();
        showError('');
        setStatus(false);
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function takePdfs(fileList) {
        var pdfs = Array.from(fileList || []).filter(function (f) {
            return f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''));
        });
        if (pdfs.length) {
            selectedFiles = pdfs;
            renderFileList();
            showError('');
        }
        return pdfs;
    }

    function clearPreview() {
        var preview = $('scanPdfPreview');
        var host = $('scanPdfPreviewHost');
        if (host) host.innerHTML = '';
        if (preview) preview.style.display = 'none';
        lastPreview = null;
    }

    function drawHighlights(canvas, hits, scale) {
        if (!canvas || !hits || !hits.length) return;
        var ctx = canvas.getContext('2d');
        ctx.save();
        ctx.fillStyle = 'rgba(255, 193, 7, 0.38)';
        ctx.strokeStyle = 'rgba(200, 150, 0, 0.9)';
        ctx.lineWidth = 1.5;
        hits.forEach(function (hit) {
            var b = hit.bbox;
            if (!b) return;
            var x = b.x * scale;
            var y = b.y * scale;
            var w = Math.max(8, b.w * scale);
            var h = Math.max(8, b.h * scale);
            ctx.fillRect(x, y, w, h);
            ctx.strokeRect(x, y, w, h);
        });
        ctx.restore();
    }

    async function renderPreview(file, extractScale, pageHits) {
        var pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
        var page = await pdf.getPage(1);
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
        var scale = previewScale / (extractScale || 1);
        drawHighlights(canvas, pageHits, scale);

        var host = $('scanPdfPreviewHost');
        var preview = $('scanPdfPreview');
        if (host && preview) {
            host.innerHTML = '';
            host.appendChild(canvas);
            preview.style.display = '';
        }
        lastPreview = { fileName: file.name, canvas: canvas };
    }

    async function extractFile(file, extractScale) {
        var buf = await file.arrayBuffer();
        var pdf = await pdfjsLib.getDocument({ data: buf }).promise;
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
            var found = FS.findMatches(queries, lines);

            var firstFile = selectedFiles[0];
            var pageHits = [];
            found.results.forEach(function (r) {
                r.hits.forEach(function (h) {
                    if (h.file === firstFile.name && h.page === 1) pageHits.push(h);
                });
            });
            setStatus(true, 'Piirretään esikatselu…', 94);
            await renderPreview(firstFile, extractScale, pageHits);

            renderResults(found, selectedFiles.length, warnings);
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

    function renderResults(found, fileCount, warnings) {
        var hitCount = 0;
        lastFoundLines = [];
        found.results.forEach(function (r) {
            r.hits.forEach(function (h) {
                hitCount++;
                lastFoundLines.push(h.full);
            });
        });

        $('scanSummaryBadge').textContent =
            hitCount + ' osumaa · ' + found.missing.length + ' puuttuu · ' +
            fileCount + (fileCount === 1 ? ' PDF' : ' PDF:ää');

        var foundHost = $('foundList');
        if (!hitCount) {
            foundHost.innerHTML = '<div class="result-empty">Ei osumia.</div>';
        } else {
            foundHost.innerHTML = found.results.map(function (r) {
                return r.hits.map(function (h) {
                    var meta = escapeHtml(h.file || '') + ' · s. ' + (h.page || 1);
                    return '<div class="result-row"><span class="result-text">' +
                        escapeHtml(h.full) + '</span><span class="result-meta">' + meta + '</span></div>';
                }).join('');
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
            var pdfs = takePdfs(e.target.files);
            if (!pdfs.length) showError('Valitse PDF-tiedosto.');
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
        dz.addEventListener('drop', function (e) {
            e.preventDefault();
            dz.classList.remove('dragover');
            var pdfs = takePdfs(e.dataTransfer && e.dataTransfer.files);
            if (!pdfs.length) showError('Valitse PDF-tiedosto.');
        });
    }

    function clearAll() {
        selectedFiles = [];
        lastFoundLines = [];
        $('nameListInput').value = '';
        $('scannerFileInput').value = '';
        $('scanReviewCard').style.display = 'none';
        renderFileList();
        clearPreview();
        showError('');
        setStatus(false);
    }

    function init() {
        bindDropzone();
        $('scanBtn').addEventListener('click', runScan);
        $('clearBtn').addEventListener('click', clearAll);
        $('copyLinesBtn').addEventListener('click', function () {
            copyText(lastFoundLines.join('\n'), $('copyLinesBtn'));
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
    }

    window.fpScanApp = {
        setFiles: function (files) {
            selectedFiles = Array.from(files || []);
            renderFileList();
        },
        runScan: runScan
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
