// PEACE Viewer: kaibu-style image/points viewer rendered on a single canvas.
//
// Layers (bottom -> top in add order):
// - image: a standalone .tif/.tiff file or a folder of tiffs (z-stack). Slices
//   are fetched and decoded lazily, one plane at a time, through the file
//   browser blueprint (/browser/dir/ serves file bytes, /browser/dir_json/
//   lists folder contents). A multi-page single TIFF also acts as a z-stack.
// - points: a CSV with napari-like coordinates — header columns 'axis-0' /
//   'axis-1' / 'axis-2' or 'z' / 'y' / 'x' (3 columns overlay the z-stack,
//   2 columns are a 2D image), falling back to positional z,y,x / y,x order.
//
// Paths arrive via the shared file browser modal (browser_modal.html +
// browser_picker.js): the postMessage payload is
// {fieldId, selectedPath, fileName, nextBrowserPath} where fieldId is
// 'viewer-image-path' or 'viewer-points-path'.

(function () {
    'use strict';

    var SLICE_CACHE_MAX = 8;   // decoded raw slices kept per image layer
    var PAINT_CACHE_MAX = 8;   // rendered (contrast-applied) canvases per layer
    var POINT_EDGE = 'rgba(20, 20, 20, 0.85)';
    var POINT_RADIUS = 3.5;
    var CLASS_COLORS = [
        '#ffdd00', // class 1
        '#3b82f6',
        '#ef4444',
        '#22d3ee',
        '#f97316',
        '#a855f7',
        '#22c55e',
        '#f472b6'
    ];
    var MAX_CLASSES = CLASS_COLORS.length;
    // Points that have not been assigned a class yet render gray
    var UNCLASSIFIED_COLOR = '#9ca3af';
    var PICK_RADIUS = 6;   // screen px around a point that counts as a hit
    var SELECT_RING = '#ffffff';
    var CLICK_SLOP = 4;    // px of mouse movement separating a click from a drag
    var VIEW_BG = '#1a1f29';
    var MIN_SCALE = 0.001;
    var MAX_SCALE = 200;

    var layers = [];
    var activeLayerId = null;
    var nextLayerId = 1;
    var hintKind = 'default';
    var lastAdded = null;

    // Points tools: one canvas interaction mode at a time. 'select' suspends
    // panning (a drag draws the selection rectangle instead).
    var canvasMode = 'none';   // 'none' | 'add' | 'select' | 'classify'
    var rectDrag = null;       // rectangle select in progress: screen coords
    var additiveSelect = false;

    var view = { scale: 1, tx: 0, ty: 0, fitted: false };

    var el = {};
    var ctx = null;
    var canvasW = 0;
    var canvasH = 0;
    var dpr = 1;

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function $(id) {
        return document.getElementById(id);
    }

    function basename(path) {
        var clean = String(path || '').replace(/\/+$/, '');
        var idx = clean.lastIndexOf('/');
        return idx >= 0 ? clean.slice(idx + 1) : clean;
    }

    function isTiffPath(path) {
        return /\.tiff?$/i.test(String(path || ''));
    }

    function clamp(v, lo, hi) {
        return Math.min(hi, Math.max(lo, v));
    }

    function setLru(map, key, value, max) {
        if (map.has(key)) map.delete(key);
        map.set(key, value);
        while (map.size > max) {
            map.delete(map.keys().next().value);
        }
    }

    // The embed picker's nextBrowserPath is either '/browser/dir_embed/<root>/...'
    // (window.location.pathname of the picker iframe) or the selected folder's
    // html path '/browser/dir/<root>/...' (folder Select). Normalize both to
    // the html path below the browser blueprint: '/<root>/...'
    function htmlPathFromBrowserPath(browserPath) {
        var p = String(browserPath || '/browser/dir_embed/');
        var embedAt = p.indexOf('/dir_embed');
        if (embedAt !== -1) {
            p = p.slice(embedAt + '/dir_embed'.length);
        } else {
            var dirAt = p.indexOf('/dir/');
            if (dirAt !== -1) {
                p = p.slice(dirAt + '/dir'.length);
            } else if (p.indexOf('/dir') !== -1) {
                p = p.slice(p.indexOf('/dir') + '/dir'.length);
            } else if (!p.startsWith('/')) {
                p = '/' + p;
            }
        }
        if (!p.startsWith('/')) p = '/' + p;
        return p;
    }

    function fileUrlFor(msg) {
        var parent = htmlPathFromBrowserPath(msg.nextBrowserPath);
        var base = parent.endsWith('/') ? parent : parent + '/';
        var name = msg.fileName || basename(msg.selectedPath);
        return '/browser/dir' + base + encodeURIComponent(name);
    }

    function folderListingUrlFor(msg) {
        var htmlPath = htmlPathFromBrowserPath(msg.nextBrowserPath);
        if (htmlPath.endsWith('/')) htmlPath = htmlPath.slice(0, -1);
        return '/browser/dir_json' + htmlPath;
    }

    function layerById(id) {
        for (var i = 0; i < layers.length; i++) {
            if (layers[i].id === id) return layers[i];
        }
        return null;
    }

    // Topmost visible image layer: drives the shared view and the z plane
    // that points layers are filtered against.
    function referenceImageLayer() {
        for (var i = layers.length - 1; i >= 0; i--) {
            var layer = layers[i];
            if (layer.type === 'image' && layer.visible) return layer;
        }
        return null;
    }

    // The image layer the sliders act on: the active layer when it is an
    // image, otherwise the reference image layer.
    function sliderImageLayer() {
        var active = layerById(activeLayerId);
        if (active && active.type === 'image') return active;
        return referenceImageLayer();
    }

    // ------------------------------------------------------------------
    // Hints
    // ------------------------------------------------------------------

    function showDefaultHint() {
        hintKind = 'default';
        if (layers.length === 0) {
            el.hint.textContent = 'Click "Add layer" to load an image or points CSV.';
            el.hint.classList.remove('d-none', 'viewer-hint-error');
            el.hint.classList.add('viewer-hint-muted');
        } else {
            el.hint.classList.add('d-none');
        }
    }

    function hideHint() {
        hintKind = 'default';
        el.hint.classList.add('d-none');
    }

    function showHint(text, kind) {
        hintKind = kind || 'default';
        el.hint.textContent = text;
        el.hint.classList.remove('d-none', 'viewer-hint-error');
        if (hintKind === 'error') {
            el.hint.classList.add('viewer-hint-error');
        } else {
            el.hint.classList.add('viewer-hint-muted');
        }
    }

    function errorHint(text) {
        showHint(text, 'error');
    }

    // ------------------------------------------------------------------
    // CSV points parsing (quote-tolerant)
    // ------------------------------------------------------------------

    function parseCsvRows(text) {
        var rows = [];
        var row = [];
        var field = '';
        var inQuotes = false;
        for (var i = 0; i < text.length; i++) {
            var ch = text[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (text[i + 1] === '"') {
                        field += '"';
                        i++;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    field += ch;
                }
            } else if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                row.push(field);
                field = '';
            } else if (ch === '\n') {
                row.push(field);
                field = '';
                rows.push(row);
                row = [];
            } else if (ch === '\r') {
                // skip (\r\n line endings)
            } else {
                field += ch;
            }
        }
        if (field !== '' || row.length > 0) {
            row.push(field);
            rows.push(row);
        }
        return rows.filter(function (r) {
            return r.length > 0 && r.some(function (c) { return c.trim() !== ''; });
        });
    }

    function isNumericCell(value) {
        return value.trim() !== '' && isFinite(Number(value.trim()));
    }

    // napari-like coordinate convention. Columns are resolved by header name
    // first ('axis-0'/'z', 'axis-1'/'y', 'axis-2'/'x'), falling back to
    // positional order: 3 columns -> z, y, x; 2 columns -> y, x.
    function parsePointsCsv(text) {
        var rows = parseCsvRows(text);
        if (rows.length === 0) return [];

        var header = null;
        var dataRows = rows;
        if (!rows[0].every(isNumericCell)) {
            header = rows[0].map(function (c) { return c.trim().toLowerCase(); });
            dataRows = rows.slice(1);
        }

        var nCols = header ? header.length : rows[0].length;
        var ix = -1;
        var iy = -1;
        var iz = -1;
        if (header) {
            var idxOf = function (names) {
                return header.findIndex(function (h) { return names.indexOf(h) !== -1; });
            };
            if (nCols >= 3) {
                ix = idxOf(['x', 'axis-2']);
                iy = idxOf(['y', 'axis-1']);
                iz = idxOf(['z', 'axis-0']);
            } else {
                ix = idxOf(['x', 'axis-1']);
                iy = idxOf(['y', 'axis-0']);
            }
        }
        if (ix < 0) ix = nCols - 1;
        if (iy < 0) iy = nCols - 2;
        if (iz < 0 && nCols >= 3) iz = nCols - 3;
        if (iy < 0 || ix < 0) return [];

        var points = [];
        for (var r = 0; r < dataRows.length; r++) {
            var cells = dataRows[r];
            if (cells.length <= Math.max(ix, iy)) continue;
            var x = Number(String(cells[ix]).trim());
            var y = Number(String(cells[iy]).trim());
            if (!isFinite(x) || !isFinite(y)) continue;
            var z = null;
            if (iz >= 0 && cells.length > iz) {
                var zv = Number(String(cells[iz]).trim());
                if (isFinite(zv)) z = zv;
            }
            points.push({ z: z, y: y, x: x });
        }
        return points;
    }

    // ------------------------------------------------------------------
    // Points layer export (canonical napari-style CSV)
    // ------------------------------------------------------------------

    function downloadBlob(blob, filename) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Safari ignores the download attribute if the URL is revoked too early
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    function pointsCsvName(name) {
        var base = basename(name);
        return /\.csv$/i.test(base) ? base : base + '.csv';
    }

    // Canonical napari-style CSV that round-trips through parsePointsCsv:
    // 3-column layers (any z present) export header axis-0,axis-1,axis-2
    // with z,y,x rows; 2-column layers export axis-0,axis-1 with y,x rows.
    function pointsCsvText(coords) {
        var hasZ = coords.some(function (p) { return p.z !== null; });
        var lines = [hasZ ? 'axis-0,axis-1,axis-2' : 'axis-0,axis-1'];
        for (var i = 0; i < coords.length; i++) {
            var p = coords[i];
            if (hasZ) {
                lines.push((p.z === null ? '' : String(p.z)) + ',' + String(p.y) + ',' + String(p.x));
            } else {
                lines.push(String(p.y) + ',' + String(p.x));
            }
        }
        return lines.join('\n') + '\n';
    }

    function exportPointsCsv(layer) {
        if (!layer.coords || layer.coords.length === 0) {
            errorHint('Nothing to export in ' + layer.name + '.');
            return;
        }
        var groups = classifyExportGroups(layer);
        if (groups) {
            // classified layer with at least one non-empty class: one
            // <name>_classN.csv per non-empty class in ascending order, plus
            // <name>_unclassified.csv for the points still unassigned
            for (var g = 0; g < groups.classes.length; g++) {
                var blob = new Blob([pointsCsvText(groups.classes[g].points)], { type: 'text/csv;charset=utf-8' });
                downloadBlob(blob, classFileNameFor(layer.name, groups.classes[g].k));
            }
            if (groups.unclassified.length > 0) {
                var ublob = new Blob([pointsCsvText(groups.unclassified)], { type: 'text/csv;charset=utf-8' });
                downloadBlob(ublob, unclassifiedFileNameFor(layer.name));
            }
            return;
        }
        var plain = new Blob([pointsCsvText(layer.coords)], { type: 'text/csv;charset=utf-8' });
        downloadBlob(plain, pointsCsvName(layer.name));
    }

    // Strip a .csv/.CSV extension so a class suffix can be appended.
    function pointsExportBase(name) {
        return basename(name).replace(/\.csv$/i, '');
    }

    function classFileNameFor(name, k) {
        return pointsExportBase(name) + '_class' + k + '.csv';
    }

    function unclassifiedFileNameFor(name) {
        return pointsExportBase(name) + '_unclassified.csv';
    }

    // Export groups for a classified layer: null when the layer has no
    // classification or no class has points (plain <name>.csv, no suffix);
    // otherwise the non-empty classes in ascending order plus the points
    // that are still unclassified.
    function classifyExportGroups(layer) {
        if (!layer.classified) return null;
        var classes = [];
        for (var k = 1; k <= (layer.classCount || 1); k++) {
            var pts = layer.coords.filter(function (p) { return p.c === k; });
            if (pts.length > 0) classes.push({ k: k, points: pts });
        }
        if (classes.length === 0) return null;
        var unclassified = [];
        for (var i = 0; i < layer.coords.length; i++) {
            if (!layer.coords[i].c) unclassified.push(layer.coords[i]);
        }
        return { classes: classes, unclassified: unclassified };
    }

    // ------------------------------------------------------------------
    // Points tools: pure helpers (pick, rect select, classify)
    // ------------------------------------------------------------------

    // 3-column points carry z and only participate on their plane; 2-column
    // points (z null) always participate.
    function pointEligible(p, viewZ) {
        return p.z === null || viewZ === null || p.z === viewZ;
    }

    function classColor(c) {
        return CLASS_COLORS[(c - 1) % CLASS_COLORS.length];
    }

    function pointFillColor(p) {
        return p.c ? classColor(p.c) : UNCLASSIFIED_COLOR;
    }

    // Class cycling: 1 -> 2 -> ... -> N -> 1 (wraps around); a point that
    // was never classified starts at class 1.
    function nextClass(c, classCount) {
        var n = Math.max(1, classCount || 1);
        if (!c || c < 1) return 1;
        return (c % n) + 1;
    }

    // Nearest z-eligible point within `radius` screen px of (sx, sy);
    // returns the index into coords or -1.
    function pickPointIndex(coords, sx, sy, view, viewZ, radius) {
        var best = -1;
        var bestDist = radius * radius;
        for (var i = 0; i < coords.length; i++) {
            var p = coords[i];
            if (!pointEligible(p, viewZ)) continue;
            var px = view.tx + p.x * view.scale;
            var py = view.ty + p.y * view.scale;
            var dx = px - sx;
            var dy = py - sy;
            var d2 = dx * dx + dy * dy;
            if (d2 <= bestDist) {
                bestDist = d2;
                best = i;
            }
        }
        return best;
    }

    // Indices of z-eligible points inside the world-space rectangle
    // (wx0, wy0) - (wx1, wy1).
    function pointsInWorldRect(coords, wx0, wy0, wx1, wy1, viewZ) {
        var loX = Math.min(wx0, wx1);
        var hiX = Math.max(wx0, wx1);
        var loY = Math.min(wy0, wy1);
        var hiY = Math.max(wy0, wy1);
        var hits = [];
        for (var i = 0; i < coords.length; i++) {
            var p = coords[i];
            if (!pointEligible(p, viewZ)) continue;
            if (p.x >= loX && p.x <= hiX && p.y >= loY && p.y <= hiY) hits.push(i);
        }
        return hits;
    }

    // ------------------------------------------------------------------
    // TIFF decoding (geotiff.js)
    // ------------------------------------------------------------------

    // Normalize the different readRasters() result shapes into the slice
    // layout the renderers expect:
    // - geotiff.js 2.x returns an array of sample planes with width/height
    //   attached as properties on the array itself
    // - other shapes: {width, height, data} where data is a TypedArray
    //   (interleaved) or an array of planes (planar)
    function normalizeRasters(image, rasters) {
        var width = image.getWidth();
        var height = image.getHeight();
        var sppMeta = image.getSamplesPerPixel();
        if (Array.isArray(rasters)) {
            return { width: width, height: height, spp: Math.max(1, rasters.length), interleaved: false, data: rasters };
        }
        if (ArrayBuffer.isView(rasters)) {
            // single flat buffer: interleaved when the image has several samples
            if (sppMeta > 1) {
                return { width: width, height: height, spp: sppMeta, interleaved: true, data: rasters };
            }
            return { width: width, height: height, spp: 1, interleaved: false, data: [rasters] };
        }
        if (!rasters || rasters.data === undefined || rasters.data === null) {
            throw new Error('unexpected readRasters() result');
        }
        if (Array.isArray(rasters.data)) {
            return { width: width, height: height, spp: Math.max(1, rasters.data.length), interleaved: false, data: rasters.data };
        }
        if (sppMeta > 1) {
            return { width: width, height: height, spp: sppMeta, interleaved: true, data: rasters.data };
        }
        return { width: width, height: height, spp: 1, interleaved: false, data: [rasters.data] };
    }

    async function readSliceRaw(layer, z, signal) {
        var image;
        if (layer.mode === 'file') {
            image = await layer.tiff.getImage(z);
        } else {
            var resp = await fetch(layer.urls[z], { signal: signal });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            var buf = await resp.arrayBuffer();
            var tiff = await GeoTIFF.fromArrayBuffer(buf);
            image = await tiff.getImage(0);
        }
        var width = image.getWidth();
        var height = image.getHeight();
        if (width <= 0 || height <= 0) throw new Error('image has no pixels');
        var rasters = await image.readRasters();
        return normalizeRasters(image, rasters);
    }

    function computeRange(slice) {
        var min = Infinity;
        var max = -Infinity;
        var n = slice.width * slice.height;
        var c;
        var i;
        if (slice.interleaved) {
            var channels = Math.min(slice.spp, 3);
            for (i = 0; i < n; i++) {
                for (c = 0; c < channels; c++) {
                    var v = slice.data[i * slice.spp + c];
                    if (v < min) min = v;
                    if (v > max) max = v;
                }
            }
        } else {
            var planes = Math.min(slice.spp, 3);
            for (c = 0; c < planes; c++) {
                var plane = slice.data[c];
                for (i = 0; i < n; i++) {
                    var w = plane[i];
                    if (w < min) min = w;
                    if (w > max) max = w;
                }
            }
        }
        if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
        if (max <= min) max = min + 1;
        return { min: min, max: max };
    }

    // Slider domain for the contrast window: unsigned integer images get
    // 0 to the dtype maximum (0-255, 0-65535); signed integers and floats
    // fall back to the slice data's min/max (a float32 dtype max of ~3.4e38
    // would make the slider unusable).
    function contrastDomain(slice, dataRange) {
        var first = Array.isArray(slice.data) ? slice.data[0] : slice.data;
        var name = first && first.constructor ? first.constructor.name : '';
        if (name === 'Uint8Array') return { min: 0, max: 255, step: 1 };
        if (name === 'Uint16Array') return { min: 0, max: 65535, step: 1 };
        if (name === 'Uint32Array') return { min: 0, max: 4294967295, step: 1 };
        var span = (dataRange.max - dataRange.min) || 1;
        var step = (name === 'Float32Array' || name === 'Float64Array') ? span / 1000 : 1;
        return { min: dataRange.min, max: dataRange.max, step: step };
    }

    // Map the raw values through the contrast window into an 8-bit canvas.
    function renderSliceCanvas(slice, cmin, cmax) {
        var w = slice.width;
        var h = slice.height;
        var n = w * h;
        var out = new Uint8ClampedArray(n * 4);
        var range = cmax > cmin ? (cmax - cmin) : 1;
        var scale = 255 / range;
        var i;
        var c;
        var o;
        var v;
        if (slice.spp === 1) {
            var plane = slice.interleaved ? slice.data : slice.data[0];
            for (i = 0; i < n; i++) {
                v = (plane[i] - cmin) * scale;
                o = i * 4;
                out[o] = v;
                out[o + 1] = v;
                out[o + 2] = v;
                out[o + 3] = 255;
            }
        } else {
            var alphaPlane = (!slice.interleaved && slice.spp >= 4) ? slice.data[3] : null;
            var hasAlpha = slice.spp >= 4;
            for (i = 0; i < n; i++) {
                o = i * 4;
                for (c = 0; c < 3; c++) {
                    if (slice.interleaved) {
                        out[o + c] = (slice.data[i * slice.spp + c] - cmin) * scale;
                    } else {
                        out[o + c] = (slice.data[c][i] - cmin) * scale;
                    }
                }
                if (alphaPlane) {
                    out[o + 3] = alphaPlane[i];
                } else if (hasAlpha) {
                    out[o + 3] = slice.data[i * slice.spp + 3];
                } else {
                    out[o + 3] = 255;
                }
            }
        }
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);
        return canvas;
    }

    function paintSlice(layer, z) {
        var raw = layer.slices.get(z);
        if (!raw) return;
        var canvas = renderSliceCanvas(raw, layer.contrast.min, layer.contrast.max);
        setLru(layer.paint, z, { canvas: canvas, cmin: layer.contrast.min, cmax: layer.contrast.max }, cacheCap(layer));
    }

    // Cache caps: a count-based cap would hold ~1GB for 4067x5119 16-bit
    // slices (raw + painted RGBA), so the cap is derived from a byte budget
    // per layer once the slice dimensions are known.
    var SLICE_CACHE_BYTES = 400 * 1024 * 1024;
    function cacheCap(layer) {
        if (!layer.sliceBytes) return SLICE_CACHE_MAX;
        return Math.max(2, Math.min(SLICE_CACHE_MAX, Math.floor(SLICE_CACHE_BYTES / layer.sliceBytes)));
    }

    // Abort in-flight slice fetches for other z positions: dragging the z
    // slider across a large stack would otherwise queue a 40MB+ download per
    // position it passes.
    function abortStaleSliceFetches(layer, keepZ) {
        if (!layer.inflight) return;
        layer.inflight.forEach(function (ctrl, z) {
            if (z !== keepZ) {
                layer.inflight.delete(z);
                ctrl.abort();
            }
        });
    }

    // Lazily fetch + decode one z plane, then render it with the current
    // contrast window. In-flight requests are deduplicated per layer, and
    // failed slices are never auto-retried (a draw()/fitView() pass would
    // otherwise re-trigger the fetch forever and freeze the page).
    function ensureSlice(layer, z) {
        if (layer.failed.has(z) || layer.slices.has(z) || layer.loading.has(z)) return;
        layer.loading.set(z, true);
        var ctrl = new AbortController();
        layer.inflight.set(z, ctrl);
        readSliceRaw(layer, z, ctrl.signal)
            .then(function (slice) {
                if (!layer.sliceBytes) {
                    layer.sliceBytes = slice.width * slice.height * 6;  // raw 16-bit + painted RGBA
                }
                if (!layer.dataRange) {
                    layer.dataRange = computeRange(slice);
                    layer.float = !Number.isInteger(layer.dataRange.min) || !Number.isInteger(layer.dataRange.max);
                    layer.contrastDomain = contrastDomain(slice, layer.dataRange);
                    layer.contrast = { min: layer.dataRange.min, max: layer.dataRange.max };
                    if (sliderImageLayer() === layer) syncSliders();
                }
                setLru(layer.slices, z, slice, cacheCap(layer));
            })
            .then(function () { paintSlice(layer, z); })
            .catch(function (err) {
                if (err && err.name === 'AbortError') {
                    // canceled in favor of another slice: not a failure
                    return;
                }
                layer.failed.add(z);
                showHint('Failed to load slice ' + z + ' of ' + layer.name + ': ' + err.message, 'error');
            })
            .finally(function () {
                layer.inflight.delete(z);
                layer.loading.delete(z);
                if (layer.z === z && layer.visible) {
                    if (!view.fitted) fitView();
                    else draw();
                }
            });
    }

    // ------------------------------------------------------------------
    // Layer management
    // ------------------------------------------------------------------

    function makeLayer(type, name) {
        return {
            id: nextLayerId++,
            type: type,
            name: name,
            visible: true
        };
    }

    // The embed picker can deliver the same selection twice (its Select
    // handler may fire twice); ignore a duplicate within a short window.
    function recentDuplicate(type, name) {
        var now = Date.now();
        if (lastAdded && lastAdded.type === type && lastAdded.name === name && (now - lastAdded.time) < 1200) {
            return true;
        }
        lastAdded = { type: type, name: name, time: now };
        return false;
    }

    function addImageLayer(msg) {
        var path = msg.selectedPath;
        var name = msg.fileName || basename(path);
        if (recentDuplicate('image', name)) return;
        var layer = makeLayer('image', name);
        layer.mode = isTiffPath(path) ? 'file' : 'folder';
        layer.zCount = 0;
        layer.z = 0;
        layer.slices = new Map();
        layer.paint = new Map();
        layer.loading = new Map();
        layer.failed = new Set();
        layer.inflight = new Map();
        layer.ready = false;  // flipped once the tiff/pages or folder listing resolve
        layer.sliceBytes = 0; // approximate bytes per cached slice (raw + painted)
        layer.contrast = null;
        layer.dataRange = null;
        layer.contrastDomain = null;
        layers.push(layer);
        activeLayerId = layer.id;
        view.fitted = false;  // refit to the new layer once its first slice loads
        renderLayerList();
        syncSliders();
        renderToolsPanel();
        showHint('Loading ' + name + '…', 'loading');
        initImageLayer(layer, msg);
    }

    async function initImageLayer(layer, msg) {
        try {
            if (layer.mode === 'folder') {
                var resp = await fetch(folderListingUrlFor(msg));
                if (!resp.ok) throw new Error('folder listing failed (HTTP ' + resp.status + ')');
                var data = await resp.json();
                var files = data.files || [];
                var names = data.files_name || [];
                var urls = [];
                for (var i = 0; i < files.length; i++) {
                    var nm = names[i] !== undefined ? names[i] : basename(files[i]);
                    if (isTiffPath(nm)) urls.push(files[i]);
                }
                if (urls.length === 0) throw new Error('no tif/tiff files in this folder');
                layer.urls = urls;
                layer.zCount = urls.length;
            } else {
                var fileResp = await fetch(fileUrlFor(msg));
                if (!fileResp.ok) throw new Error('image download failed (HTTP ' + fileResp.status + ')');
                var buf = await fileResp.arrayBuffer();
                layer.tiff = await GeoTIFF.fromArrayBuffer(buf);
                layer.zCount = await layer.tiff.getImageCount();
            }
            layer.ready = true;
            syncSliders();
            ensureSlice(layer, layer.z);
            draw();
        } catch (err) {
            removeLayer(layer.id, true);
            errorHint('Failed to load ' + layer.name + ': ' + err.message);
        }
    }

    function addPointsLayer(msg) {
        var path = msg.selectedPath;
        var name = msg.fileName || basename(path);
        if (recentDuplicate('points', name)) return;
        showHint('Loading ' + name + '…', 'loading');
        fetch(fileUrlFor(msg))
            .then(function (resp) {
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                return resp.text();
            })
            .then(function (text) {
                var coords = parsePointsCsv(text).map(function (p) {
                    return { z: p.z, y: p.y, x: p.x, c: null, sel: false };
                });
                if (coords.length === 0) throw new Error('no coordinate rows found');
                var layer = makeLayer('points', name);
                layer.coords = coords;
                layer.classified = false;
                layer.classCount = 2;
                layers.push(layer);
                activeLayerId = layer.id;
                renderLayerList();
                syncSliders();
                renderToolsPanel();
                draw();
            })
            .catch(function (err) {
                errorHint('Failed to load ' + name + ': ' + err.message);
            });
    }

    function removeLayer(id, silent) {
        var idx = layers.findIndex(function (l) { return l.id === id; });
        if (idx === -1) return;
        layers.splice(idx, 1);
        if (activeLayerId === id) {
            activeLayerId = layers.length ? layers[layers.length - 1].id : null;
        }
        renderLayerList();
        syncSliders();
        renderToolsPanel();
        if (layers.length === 0) {
            view.fitted = false;
            view.scale = 1;
            view.tx = 0;
            view.ty = 0;
        }
        if (!silent) draw();
        if (layers.length === 0) showDefaultHint();
    }

    function setActive(id) {
        if (activeLayerId === id) return;
        activeLayerId = id;
        renderLayerList();
        syncSliders();
        renderToolsPanel();
    }

    // ------------------------------------------------------------------
    // Layer list panel
    // ------------------------------------------------------------------

    function renderLayerList() {
        var list = el.layerList;
        list.textContent = '';
        if (el.layerCount) {
            el.layerCount.textContent = layers.length ? String(layers.length) : '';
        }
        if (layers.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'viewer-layer-empty';
            empty.textContent = 'No layers yet.';
            list.appendChild(empty);
            return;
        }
        // top of the stack first, like kaibu
        for (var i = layers.length - 1; i >= 0; i--) {
            list.appendChild(buildLayerItem(layers[i]));
        }
    }

    function buildLayerItem(layer) {
        var item = document.createElement('div');
        item.className = 'viewer-layer-item' + (layer.id === activeLayerId ? ' active' : '');
        item.dataset.layerId = String(layer.id);

        var typeIcon = document.createElement('i');
        typeIcon.className = 'bi ' + (layer.type === 'image' ? 'bi-image' : 'bi-record-circle') + ' viewer-layer-type';
        typeIcon.title = layer.type === 'image' ? 'Image layer' : 'Points layer';

        var eye = document.createElement('button');
        eye.type = 'button';
        eye.className = 'viewer-layer-eye btn btn-sm';
        eye.dataset.action = 'toggle';
        eye.title = layer.visible ? 'Hide layer' : 'Show layer';
        var eyeIcon = document.createElement('i');
        eyeIcon.className = 'bi ' + (layer.visible ? 'bi-eye' : 'bi-eye-slash');
        eye.appendChild(eyeIcon);

        var name = document.createElement('span');
        name.className = 'viewer-layer-name text-truncate';
        name.title = layer.name;
        name.textContent = layer.name;

        var menuWrap = document.createElement('div');
        menuWrap.className = 'dropdown viewer-layer-menu';
        var kebab = document.createElement('button');
        kebab.type = 'button';
        kebab.className = 'viewer-layer-kebab btn btn-sm';
        kebab.dataset.bsToggle = 'dropdown';
        kebab.setAttribute('aria-expanded', 'false');
        kebab.title = 'Layer options';
        var kebabIcon = document.createElement('i');
        kebabIcon.className = 'bi bi-three-dots-vertical';
        kebab.appendChild(kebabIcon);
        var menu = document.createElement('ul');
        menu.className = 'dropdown-menu dropdown-menu-end';
        if (layer.type === 'points') {
            var exLi = document.createElement('li');
            var ex = document.createElement('button');
            ex.type = 'button';
            ex.className = 'dropdown-item viewer-layer-export';
            ex.dataset.action = 'export';
            ex.title = 'Export layer as CSV';
            var exIcon = document.createElement('i');
            exIcon.className = 'bi bi-download me-2';
            ex.appendChild(exIcon);
            ex.appendChild(document.createTextNode('Export'));
            exLi.appendChild(ex);
            menu.appendChild(exLi);
        }
        var li = document.createElement('li');
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'dropdown-item text-danger viewer-layer-delete';
        del.dataset.action = 'delete';
        var delIcon = document.createElement('i');
        delIcon.className = 'bi bi-trash me-2';
        del.appendChild(delIcon);
        del.appendChild(document.createTextNode('Delete'));
        li.appendChild(del);
        menu.appendChild(li);
        menuWrap.appendChild(kebab);
        menuWrap.appendChild(menu);

        item.appendChild(typeIcon);
        item.appendChild(eye);
        item.appendChild(name);
        item.appendChild(menuWrap);
        return item;
    }

    function attachPanelEvents() {
        el.layerList.addEventListener('click', function (event) {
            var item = event.target.closest('.viewer-layer-item');
            if (!item) return;
            var layer = layerById(parseInt(item.dataset.layerId, 10));
            if (!layer) return;
            var actionEl = event.target.closest('[data-action]');
            if (actionEl) {
                if (actionEl.dataset.action === 'toggle') {
                    layer.visible = !layer.visible;
                    renderLayerList();
                    draw();
                } else if (actionEl.dataset.action === 'export') {
                    exportPointsCsv(layer);
                } else if (actionEl.dataset.action === 'delete') {
                    removeLayer(layer.id);
                }
                return;
            }
            setActive(layer.id);
        });

        document.querySelectorAll('.viewer-add-layer').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var type = btn.dataset.layerType;
                if (type === 'image' && typeof GeoTIFF === 'undefined') {
                    errorHint('geotiff.js failed to load — cannot decode TIFF images.');
                    return;
                }
                if (typeof openFileBrowser !== 'function') {
                    errorHint('File browser picker not available.');
                    return;
                }
                openFileBrowser(type === 'image' ? 'viewer-image-path' : 'viewer-points-path');
            });
        });
    }

    // ------------------------------------------------------------------
    // Points tools panel
    // ------------------------------------------------------------------

    function activePointsLayer() {
        var layer = layerById(activeLayerId);
        return layer && layer.type === 'points' ? layer : null;
    }

    // Enabling classification starts every point as unclassified (c null);
    // clicking points with the Classify tool then assigns their classes.
    function activateClassification(layer) {
        layer.classified = true;
        if (!layer.classCount) layer.classCount = 2;
    }

    function setCanvasMode(mode) {
        // entering classify mode activates classification: every point
        // starts as unclassified and is colored as its class once clicked
        if (mode === 'classify') {
            var layer = activePointsLayer();
            if (layer && !layer.classified) activateClassification(layer);
        }
        canvasMode = (canvasMode === mode) ? 'none' : mode;
        rectDrag = null;
        renderToolsPanel();
        draw();
    }

    function renderToolsPanel() {
        if (!el.toolsPanel) return;
        var layer = activePointsLayer();
        if (!layer) {
            canvasMode = 'none';
            rectDrag = null;
            el.toolsNote.classList.remove('d-none');
            el.pointsTools.classList.add('d-none');
            el.canvasWrap.classList.remove('viewer-mode-add', 'viewer-mode-select', 'viewer-mode-classify');
            return;
        }
        el.toolsNote.classList.add('d-none');
        el.pointsTools.classList.remove('d-none');
        el.toolAdd.classList.toggle('active', canvasMode === 'add');
        el.toolSelect.classList.toggle('active', canvasMode === 'select');
        el.toolClassify.classList.toggle('active', canvasMode === 'classify');
        el.toolAdd.setAttribute('aria-pressed', canvasMode === 'add' ? 'true' : 'false');
        el.toolSelect.setAttribute('aria-pressed', canvasMode === 'select' ? 'true' : 'false');
        el.toolClassify.setAttribute('aria-pressed', canvasMode === 'classify' ? 'true' : 'false');
        el.canvasWrap.classList.toggle('viewer-mode-add', canvasMode === 'add');
        el.canvasWrap.classList.toggle('viewer-mode-select', canvasMode === 'select');
        el.canvasWrap.classList.toggle('viewer-mode-classify', canvasMode === 'classify');
        el.toolDelete.disabled = !layer.coords.some(function (p) { return p.sel; });
        el.selectSubPanel.classList.toggle('d-none', canvasMode !== 'select');
        el.classifySubPanel.classList.toggle('d-none', canvasMode !== 'classify');
        if (canvasMode === 'classify') {
            el.classCountInput.value = String(layer.classCount || 2);
            renderClassColorList(layer);
            updateNnControls(layer);
        }
    }

    // Train/Predict button state + model status line in the classify
    // sub-panel: Train needs a classified point on the current z plane,
    // Predict needs a trained model.
    function updateNnControls(layer) {
        var ref = referenceImageLayer();
        var sliceReady = !!(ref && ref.slices && ref.slices.has(ref.z));
        var hasClassified = false;
        if (sliceReady) {
            hasClassified = currentZPoints(layer, ref.z).some(function (p) { return p.c; });
        }
        el.nnTrain.disabled = !hasClassified;
        el.nnPredict.disabled = !layer.nn;
        if (!sliceReady) {
            el.nnStatus.textContent = 'Load an image layer and wait for the current slice to decode.';
        } else if (layer.nn) {
            el.nnStatus.textContent = 'Model: z=' + layer.nn.trainedZ + ' · ' + layer.nn.count +
                ' points · loss ' + layer.nn.loss.toFixed(3);
        } else {
            el.nnStatus.textContent = NN_NO_MODEL_TEXT;
        }
    }

    // Per-class color chips with live point counts, plus the unclassified
    // row on top (every point starts there when classification is enabled).
    function renderClassColorList(layer) {
        var wrap = el.classColorList;
        wrap.textContent = '';
        var unclassified = 0;
        for (var u = 0; u < layer.coords.length; u++) {
            if (!layer.coords[u].c) unclassified++;
        }
        var uRow = document.createElement('div');
        uRow.className = 'viewer-class-row';
        var uSwatch = document.createElement('span');
        uSwatch.className = 'viewer-class-swatch';
        uSwatch.style.backgroundColor = UNCLASSIFIED_COLOR;
        var uLabel = document.createElement('span');
        uLabel.className = 'viewer-class-label';
        uLabel.textContent = 'unclassified';
        var uBadge = document.createElement('span');
        uBadge.className = 'viewer-class-count-badge text-muted';
        uBadge.textContent = String(unclassified);
        uRow.appendChild(uSwatch);
        uRow.appendChild(uLabel);
        uRow.appendChild(uBadge);
        wrap.appendChild(uRow);
        var n = layer.classCount || 1;
        for (var k = 1; k <= n; k++) {
            var count = 0;
            for (var i = 0; i < layer.coords.length; i++) {
                if (layer.coords[i].c === k) count++;
            }
            var row = document.createElement('div');
            row.className = 'viewer-class-row';
            var swatch = document.createElement('span');
            swatch.className = 'viewer-class-swatch';
            swatch.style.backgroundColor = classColor(k);
            var label = document.createElement('span');
            label.className = 'viewer-class-label';
            label.textContent = 'class ' + k;
            var badge = document.createElement('span');
            badge.className = 'viewer-class-count-badge text-muted';
            badge.textContent = String(count);
            row.appendChild(swatch);
            row.appendChild(label);
            row.appendChild(badge);
            wrap.appendChild(row);
        }
    }

    function attachToolsEvents() {
        if (!el.toolsPanel) return;
        el.toolAdd.addEventListener('click', function () { setCanvasMode('add'); });
        el.toolSelect.addEventListener('click', function () { setCanvasMode('select'); });
        el.toolClassify.addEventListener('click', function () { setCanvasMode('classify'); });
        el.toolDelete.addEventListener('click', deleteSelectedPoints);
        el.additiveToggle.addEventListener('change', function () {
            additiveSelect = el.additiveToggle.checked;
        });
        el.classCountInput.addEventListener('change', function () {
            var layer = activePointsLayer();
            if (!layer) return;
            var n = clamp(parseInt(el.classCountInput.value, 10) || 2, 1, MAX_CLASSES);
            layer.classCount = n;
            el.classCountInput.value = String(n);
            for (var i = 0; i < layer.coords.length; i++) {
                var p = layer.coords[i];
                if (p.c && p.c > n) p.c = n;
            }
            renderToolsPanel();
        });
        el.nnTrain.addEventListener('click', trainClassifier);
        el.nnPredict.addEventListener('click', predictUnclassified);
    }

    function clearSelection(layer) {
        layer.coords.forEach(function (p) { p.sel = false; });
        renderToolsPanel();
    }

    function deleteSelectedPoints() {
        var layer = activePointsLayer();
        if (!layer) return;
        var before = layer.coords.length;
        layer.coords = layer.coords.filter(function (p) { return !p.sel; });
        if (layer.coords.length === before) return;
        draw();
        renderToolsPanel();
    }

    // Click with the add tool: append a point at the world-space click.
    // z follows the reference image plane unless the layer is 2-column
    // (every existing point has z null).
    function addPointAtClick(cx, cy) {
        var layer = activePointsLayer();
        if (!layer) return;
        var wx = (cx - view.tx) / view.scale;
        var wy = (cy - view.ty) / view.scale;
        var ref = referenceImageLayer();
        var noZ = layer.coords.every(function (p) { return p.z === null; });
        var z = noZ ? null : (ref ? ref.z : null);
        // new points start unclassified too (click to assign a class)
        layer.coords.push({ z: z, y: wy, x: wx, c: null, sel: false });
        draw();
        renderToolsPanel();
    }

    function selectPointAtClick(cx, cy) {
        var layer = activePointsLayer();
        if (!layer) return;
        var ref = referenceImageLayer();
        var viewZ = ref ? ref.z : null;
        var idx = pickPointIndex(layer.coords, cx, cy, view, viewZ, PICK_RADIUS);
        if (idx === -1) {
            if (!additiveSelect) clearSelection(layer);
            draw();
            return;
        }
        var p = layer.coords[idx];
        if (additiveSelect) {
            p.sel = !p.sel;
        } else {
            layer.coords.forEach(function (q) { q.sel = false; });
            p.sel = true;
        }
        draw();
        renderToolsPanel();
    }

    function classifyPointAtClick(cx, cy) {
        var layer = activePointsLayer();
        if (!layer || !layer.classified) return;
        var ref = referenceImageLayer();
        var viewZ = ref ? ref.z : null;
        var idx = pickPointIndex(layer.coords, cx, cy, view, viewZ, PICK_RADIUS);
        if (idx === -1) return;
        var p = layer.coords[idx];
        p.c = nextClass(p.c, layer.classCount);
        draw();
        renderToolsPanel();
    }

    // Finish a select-tool drag: a real drag selects every z-eligible point
    // inside the screen rectangle; a click on empty canvas clears the
    // selection unless additive mode is on.
    function finishRectSelect() {
        var rect = rectDrag;
        rectDrag = null;
        el.canvas.classList.remove('viewer-dragging');
        var layer = activePointsLayer();
        if (!rect || !layer) { draw(); return; }
        var moved = Math.abs(rect.x1 - rect.x0) + Math.abs(rect.y1 - rect.y0);
        var ref = referenceImageLayer();
        var viewZ = ref ? ref.z : null;
        if (moved <= CLICK_SLOP) {
            if (!additiveSelect) clearSelection(layer);
            draw();
            return;
        }
        var wx0 = (rect.x0 - view.tx) / view.scale;
        var wy0 = (rect.y0 - view.ty) / view.scale;
        var wx1 = (rect.x1 - view.tx) / view.scale;
        var wy1 = (rect.y1 - view.ty) / view.scale;
        var hits = pointsInWorldRect(layer.coords, wx0, wy0, wx1, wy1, viewZ);
        if (!additiveSelect) {
            layer.coords.forEach(function (p) { p.sel = false; });
        }
        for (var h = 0; h < hits.length; h++) {
            layer.coords[hits[h]].sel = true;
        }
        draw();
        renderToolsPanel();
    }

    // ------------------------------------------------------------------
    // Points classifier: tiny MLP trained in the browser
    // ------------------------------------------------------------------

    // The classifier uses only the current z plane (for now): training data
    // are the classified points on the reference image plane, prediction
    // runs on the unclassified points of the same plane.
    var NN_PATCH = 10;      // 10x10 intensity patch around a point
    var NN_HIDDEN = 24;     // hidden layer width
    var NN_EPOCHS = 150;    // full-batch training epochs
    var NN_LR = 0.05;       // Adam learning rate
    var NN_NO_MODEL_TEXT = 'No model yet — classify some points on this z plane, then Train.';

    // Points that participate on a z plane: 3-column points whose z matches
    // the plane plus every 2-column point (z null).
    function currentZPoints(layer, viewZ) {
        return layer.coords.filter(function (p) { return pointEligible(p, viewZ); });
    }

    // Feature vector for one point from the decoded raw slice: a normalized
    // NN_PATCH x NN_PATCH intensity patch around the point (first channel,
    // edge-clamped sampling) plus the normalized point coordinates.
    function pointFeatures(slice, p, dataRange) {
        var half = NN_PATCH / 2;
        var stride = slice.interleaved ? slice.spp : 1;
        var plane = slice.interleaved ? slice.data : slice.data[0];
        var w = slice.width;
        var h = slice.height;
        var cx = clamp(Math.round(p.x), 0, w - 1);
        var cy = clamp(Math.round(p.y), 0, h - 1);
        var span = (dataRange.max - dataRange.min) || 1;
        var f = new Array(NN_PATCH * NN_PATCH + 2);
        var k = 0;
        for (var dy = -half; dy < NN_PATCH - half; dy++) {
            for (var dx = -half; dx < NN_PATCH - half; dx++) {
                var yy = clamp(cy + dy, 0, h - 1);
                var xx = clamp(cx + dx, 0, w - 1);
                var v = plane[(yy * w + xx) * stride];
                f[k++] = (v - dataRange.min) / span;
            }
        }
        f[k++] = p.x / w;
        f[k++] = p.y / h;
        return f;
    }

    // Tiny MLP: NN_PATCH*NN_PATCH + 2 inputs -> ReLU hidden layer -> softmax
    // over the classes present. Weights are flat typed arrays so training is
    // plain loops; a few hundred points train in milliseconds.
    function nnRandWeights(n, scale) {
        var w = new Float64Array(n);
        for (var i = 0; i < n; i++) w[i] = (Math.random() * 2 - 1) * scale;
        return w;
    }

    function nnCreate(nIn, nHidden, nOut) {
        return {
            nIn: nIn,
            nHidden: nHidden,
            nOut: nOut,
            w1: nnRandWeights(nHidden * nIn, Math.sqrt(2 / nIn)),
            b1: new Float64Array(nHidden),
            w2: nnRandWeights(nOut * nHidden, Math.sqrt(2 / nHidden)),
            b2: new Float64Array(nOut)
        };
    }

    function nnForward(net, x) {
        var hidden = new Float64Array(net.nHidden);
        for (var j = 0; j < net.nHidden; j++) {
            var sum = net.b1[j];
            var off = j * net.nIn;
            for (var i = 0; i < net.nIn; i++) sum += net.w1[off + i] * x[i];
            hidden[j] = sum > 0 ? sum : 0;
        }
        var probs = new Float64Array(net.nOut);
        var max = -Infinity;
        for (var o = 0; o < net.nOut; o++) {
            var s = net.b2[o];
            var off2 = o * net.nHidden;
            for (var h = 0; h < net.nHidden; h++) s += net.w2[off2 + h] * hidden[h];
            probs[o] = s;
            if (s > max) max = s;
        }
        var total = 0;
        for (var o2 = 0; o2 < net.nOut; o2++) {
            probs[o2] = Math.exp(probs[o2] - max);
            total += probs[o2];
        }
        for (var o3 = 0; o3 < net.nOut; o3++) probs[o3] /= total;
        return { hidden: hidden, probs: probs };
    }

    function adamUpdate(p, g, m, v, batch, lr, beta1, beta2, eps, c1, c2) {
        for (var i = 0; i < p.length; i++) {
            var gi = g[i] / batch;
            m[i] = beta1 * m[i] + (1 - beta1) * gi;
            v[i] = beta2 * v[i] + (1 - beta2) * gi * gi;
            p[i] -= lr * (m[i] / c1) / (Math.sqrt(v[i] / c2) + eps);
        }
    }

    // Full-batch Adam on the cross-entropy loss; returns the mean loss of
    // the final epoch.
    function nnTrain(net, xs, labels, epochs, lr) {
        var nIn = net.nIn;
        var nHidden = net.nHidden;
        var nOut = net.nOut;
        var n = xs.length;
        var mw1 = new Float64Array(net.w1.length), vw1 = new Float64Array(net.w1.length);
        var mb1 = new Float64Array(nHidden), vb1 = new Float64Array(nHidden);
        var mw2 = new Float64Array(net.w2.length), vw2 = new Float64Array(net.w2.length);
        var mb2 = new Float64Array(nOut), vb2 = new Float64Array(nOut);
        var gw1 = new Float64Array(net.w1.length), gb1 = new Float64Array(nHidden);
        var gw2 = new Float64Array(net.w2.length), gb2 = new Float64Array(nOut);
        var beta1 = 0.9;
        var beta2 = 0.999;
        var eps = 1e-8;
        var loss = 0;
        for (var epoch = 0; epoch < epochs; epoch++) {
            gw1.fill(0); gb1.fill(0); gw2.fill(0); gb2.fill(0);
            loss = 0;
            for (var s = 0; s < n; s++) {
                var x = xs[s];
                var fw = nnForward(net, x);
                var y = labels[s];
                loss += -Math.log(Math.max(fw.probs[y], 1e-12));
                for (var o = 0; o < nOut; o++) {
                    var d = fw.probs[o] - (o === y ? 1 : 0);
                    gb2[o] += d;
                    var off = o * nHidden;
                    for (var h = 0; h < nHidden; h++) gw2[off + h] += d * fw.hidden[h];
                }
                for (var j = 0; j < nHidden; j++) {
                    if (fw.hidden[j] <= 0) continue;
                    var dh = 0;
                    for (var o2 = 0; o2 < nOut; o2++) {
                        dh += (fw.probs[o2] - (o2 === y ? 1 : 0)) * net.w2[o2 * nHidden + j];
                    }
                    var off1 = j * nIn;
                    for (var i = 0; i < nIn; i++) gw1[off1 + i] += dh * x[i];
                }
            }
            var c1 = 1 - Math.pow(beta1, epoch + 1);
            var c2 = 1 - Math.pow(beta2, epoch + 1);
            adamUpdate(net.w1, gw1, mw1, vw1, n, lr, beta1, beta2, eps, c1, c2);
            adamUpdate(net.b1, gb1, mb1, vb1, n, lr, beta1, beta2, eps, c1, c2);
            adamUpdate(net.w2, gw2, mw2, vw2, n, lr, beta1, beta2, eps, c1, c2);
            adamUpdate(net.b2, gb2, mb2, vb2, n, lr, beta1, beta2, eps, c1, c2);
        }
        return loss / n;
    }

    // Train on the classified points of the current z plane. Features come
    // from the reference image layer's decoded slice (intensity patch +
    // coordinates); the model is stored on the layer until re-trained.
    function trainClassifier() {
        var layer = activePointsLayer();
        if (!layer || !layer.classified) {
            errorHint('Enter Classify mode and assign some classes first.');
            return;
        }
        var ref = referenceImageLayer();
        if (!ref || !ref.slices || !ref.slices.has(ref.z)) {
            errorHint('The current z slice of the image layer is not loaded yet.');
            return;
        }
        var slice = ref.slices.get(ref.z);
        var pts = currentZPoints(layer, ref.z).filter(function (p) { return p.c; });
        if (pts.length === 0) {
            errorHint('No classified points on z=' + ref.z + ' — click points with the Classify tool first.');
            return;
        }
        var classSet = {};
        var classes = [];
        for (var i = 0; i < pts.length; i++) {
            var c = pts[i].c;
            if (!classSet[c]) {
                classSet[c] = true;
                classes.push(c);
            }
        }
        var xs = [];
        var labels = [];
        for (var j = 0; j < pts.length; j++) {
            xs.push(pointFeatures(slice, pts[j], ref.dataRange));
            labels.push(classes.indexOf(pts[j].c));
        }
        var net = nnCreate(NN_PATCH * NN_PATCH + 2, NN_HIDDEN, classes.length);
        var loss = nnTrain(net, xs, labels, NN_EPOCHS, NN_LR);
        layer.nn = { net: net, classes: classes, trainedZ: ref.z, count: pts.length, loss: loss };
        showHint('Trained on ' + pts.length + ' points (z=' + ref.z + ', ' + classes.length +
                 ' class' + (classes.length === 1 ? '' : 'es') + ', loss ' + loss.toFixed(3) + ').');
        renderToolsPanel();
    }

    // Predict classes for the unclassified points of the current z plane
    // only. The predicted class is assigned, so predicted points are colored
    // per class and join their class file on export.
    function predictUnclassified() {
        var layer = activePointsLayer();
        if (!layer || !layer.nn) {
            errorHint('Train the classifier first.');
            return;
        }
        var ref = referenceImageLayer();
        if (!ref || !ref.slices || !ref.slices.has(ref.z)) {
            errorHint('The current z slice of the image layer is not loaded yet.');
            return;
        }
        var slice = ref.slices.get(ref.z);
        var pts = currentZPoints(layer, ref.z).filter(function (p) { return !p.c; });
        if (pts.length === 0) {
            showHint('No unclassified points on z=' + ref.z + '.');
            return;
        }
        var predicted = 0;
        for (var i = 0; i < pts.length; i++) {
            var fw = nnForward(layer.nn.net, pointFeatures(slice, pts[i], ref.dataRange));
            var best = 0;
            for (var k = 1; k < fw.probs.length; k++) {
                if (fw.probs[k] > fw.probs[best]) best = k;
            }
            var c = layer.nn.classes[best];
            if (layer.classCount && c > layer.classCount) c = layer.classCount;
            pts[i].c = c;
            predicted++;
        }
        draw();
        renderToolsPanel();
        showHint('Predicted ' + predicted + ' point' + (predicted === 1 ? '' : 's') + ' on z=' + ref.z + '.');
    }

    // ------------------------------------------------------------------
    // Sliders
    // ------------------------------------------------------------------

    function fmtContrast(v, isFloat) {
        if (isFloat) return Number(v).toFixed(2);
        return String(Math.round(v));
    }

    function updateContrastSliders(img) {
        if (!img.contrastDomain || !img.contrast) return;
        var domain = img.contrastDomain;
        el.contrastMin.min = domain.min;
        el.contrastMin.max = domain.max;
        el.contrastMin.step = domain.step;
        el.contrastMin.value = img.contrast.min;
        el.contrastMax.min = domain.min;
        el.contrastMax.max = domain.max;
        el.contrastMax.step = domain.step;
        el.contrastMax.value = img.contrast.max;
        positionContrastFill(img);
        el.contrastMinValue.textContent = fmtContrast(img.contrast.min, img.float);
        el.contrastMaxValue.textContent = fmtContrast(img.contrast.max, img.float);
        raiseContrastHandle(img, null);
    }

    // Position the filled span of the dual slider between the two handles.
    function positionContrastFill(img) {
        var domain = img.contrastDomain;
        var span = (domain.max - domain.min) || 1;
        var lo = clamp((img.contrast.min - domain.min) / span, 0, 1) * 100;
        var hi = clamp((img.contrast.max - domain.min) / span, 0, 1) * 100;
        el.contrastFill.style.left = lo + '%';
        el.contrastFill.style.width = Math.max(0, hi - lo) + '%';
    }

    // Keep the last-touched handle grabbable when the two thumbs meet.
    function raiseContrastHandle(img, which) {
        el.contrastMin.style.zIndex = which === 'min' ? '5' : '3';
        el.contrastMax.style.zIndex = which === 'max' ? '5' : '4';
    }

    function syncSliders() {
        var img = sliderImageLayer();
        if (img && img.zCount > 1) {
            el.zRow.classList.remove('d-none');
            el.zSlider.max = img.zCount - 1;
            el.zSlider.value = img.z;
            el.zValue.textContent = 'z: ' + img.z + ' / ' + (img.zCount - 1);
        } else {
            el.zRow.classList.add('d-none');
        }
        if (img && img.contrastDomain) {
            el.contrastRow.classList.remove('d-none');
            updateContrastSliders(img);
        } else {
            el.contrastRow.classList.add('d-none');
        }
    }

    function attachSliderEvents() {
        // Dragging the z slider fires 'input' for every position it passes;
        // each slice can be 40MB+, so the load is debounced and fires once
        // the drag pauses (already-cached slices still show instantly).
        var zDebounceTimer = null;
        el.zSlider.addEventListener('input', function () {
            var img = sliderImageLayer();
            if (!img || img.zCount <= 1) return;
            img.z = clamp(parseInt(el.zSlider.value, 10) || 0, 0, img.zCount - 1);
            el.zSlider.value = img.z;
            el.zValue.textContent = 'z: ' + img.z + ' / ' + (img.zCount - 1);
            abortStaleSliceFetches(img, img.z);
            if (img.slices.has(img.z)) {
                if (zDebounceTimer) { clearTimeout(zDebounceTimer); zDebounceTimer = null; }
                draw();
                return;
            }
            if (zDebounceTimer) clearTimeout(zDebounceTimer);
            zDebounceTimer = setTimeout(function () {
                zDebounceTimer = null;
                if (!layerById(img.id)) return;  // layer was deleted mid-drag
                ensureSlice(img, img.z);
                draw();
            }, 250);
        });

        el.contrastMin.addEventListener('input', function () {
            var img = sliderImageLayer();
            if (!img || !img.contrast) return;
            var v = parseFloat(el.contrastMin.value);
            if (isNaN(v)) return;
            if (v > img.contrast.max) v = img.contrast.max;
            img.contrast.min = v;
            el.contrastMin.value = v;
            el.contrastMinValue.textContent = fmtContrast(v, img.float);
            positionContrastFill(img);
            raiseContrastHandle(img, 'min');
            draw();
        });

        el.contrastMax.addEventListener('input', function () {
            var img = sliderImageLayer();
            if (!img || !img.contrast) return;
            var v = parseFloat(el.contrastMax.value);
            if (isNaN(v)) return;
            if (v < img.contrast.min) v = img.contrast.min;
            img.contrast.max = v;
            el.contrastMax.value = v;
            el.contrastMaxValue.textContent = fmtContrast(v, img.float);
            positionContrastFill(img);
            raiseContrastHandle(img, 'max');
            draw();
        });
    }

    // ------------------------------------------------------------------
    // Canvas: view transform, zoom, pan, fit
    // ------------------------------------------------------------------

    function fitView() {
        var img = referenceImageLayer();
        if (!img || !img.ready) return;
        var raw = img.slices.get(img.z);
        if (!raw) {
            ensureSlice(img, img.z);
            return;
        }
        var scale = Math.min(canvasW / raw.width, canvasH / raw.height);
        if (!isFinite(scale) || scale <= 0) scale = 1;
        view.scale = scale;
        view.tx = (canvasW - raw.width * scale) / 2;
        view.ty = (canvasH - raw.height * scale) / 2;
        view.fitted = true;
        draw();
    }

    function drawImageLayer(layer) {
        // Skip layers whose data source has not resolved yet: drawing them
        // would call ensureSlice()/readSliceRaw() before layer.tiff/urls
        // exist and mark the slice as failed before the real load lands.
        if (!layer.ready) return;
        var z = layer.z;
        var entry = layer.paint.get(z);
        if (!entry || entry.cmin !== layer.contrast.min || entry.cmax !== layer.contrast.max) {
            if (layer.slices.has(z)) {
                paintSlice(layer, z);
                entry = layer.paint.get(z);
            } else {
                ensureSlice(layer, z);
                return;
            }
        }
        if (!entry) return;
        ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.tx, dpr * view.ty);
        ctx.imageSmoothingEnabled = view.scale < 1;
        ctx.drawImage(entry.canvas, 0, 0);
    }

    function drawPointsLayer(layer, viewZ) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        for (var i = 0; i < layer.coords.length; i++) {
            var p = layer.coords[i];
            // napari convention: 3-column CSVs carry z (axis-0); points whose z
            // differs from the current plane are hidden. 2-column points show
            // on every plane.
            if (p.z !== null && viewZ !== null && p.z !== viewZ) continue;
            var sx = view.tx + p.x * view.scale;
            var sy = view.ty + p.y * view.scale;
            var margin = POINT_RADIUS + 3;  // ring extends past the point edge
            if (sx < -margin || sy < -margin ||
                sx > canvasW + margin || sy > canvasH + margin) continue;
            ctx.beginPath();
            ctx.arc(sx, sy, POINT_RADIUS, 0, Math.PI * 2);
            ctx.fillStyle = pointFillColor(p);
            ctx.fill();
            ctx.strokeStyle = POINT_EDGE;
            ctx.lineWidth = 1;
            ctx.stroke();
            if (p.sel) {
                // selected: white highlight ring around the point
                ctx.beginPath();
                ctx.arc(sx, sy, POINT_RADIUS + 2.5, 0, Math.PI * 2);
                ctx.strokeStyle = SELECT_RING;
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }
        }
    }

    function draw() {
        if (!ctx) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = VIEW_BG;
        ctx.fillRect(0, 0, canvasW, canvasH);

        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i];
            if (!layer.visible) continue;
            if (layer.type === 'image') {
                drawImageLayer(layer);
            } else {
                var ref = referenceImageLayer();
                drawPointsLayer(layer, ref ? ref.z : null);
            }
        }

        // selection rectangle in progress (select tool drag)
        if (rectDrag) {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.strokeStyle = SELECT_RING;
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(Math.min(rectDrag.x0, rectDrag.x1), Math.min(rectDrag.y0, rectDrag.y1),
                           Math.abs(rectDrag.x1 - rectDrag.x0), Math.abs(rectDrag.y1 - rectDrag.y0));
            ctx.setLineDash([]);
        }

        var ref = referenceImageLayer();
        if (ref && !ref.paint.has(ref.z)) {
            if (ref.ready && hintKind === 'default') showHint('Loading slice ' + ref.z + '…', 'loading');
        } else if (layers.length === 0) {
            showDefaultHint();
        } else if (hintKind === 'loading') {
            hideHint();
        }
    }

    function resizeCanvas() {
        if (!el.canvasWrap) return;
        var rect = el.canvasWrap.getBoundingClientRect();
        dpr = window.devicePixelRatio || 1;
        canvasW = Math.max(50, Math.floor(rect.width));
        canvasH = Math.max(50, Math.floor(rect.height));
        el.canvas.width = Math.floor(canvasW * dpr);
        el.canvas.height = Math.floor(canvasH * dpr);
        el.canvas.style.width = canvasW + 'px';
        el.canvas.style.height = canvasH + 'px';
        draw();
    }

    function attachCanvasEvents() {
        el.canvas.addEventListener('wheel', function (e) {
            e.preventDefault();
            var factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
            var rect = el.canvas.getBoundingClientRect();
            var cx = e.clientX - rect.left;
            var cy = e.clientY - rect.top;
            var newScale = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
            if (newScale === view.scale) return;
            var wx = (cx - view.tx) / view.scale;
            var wy = (cy - view.ty) / view.scale;
            view.tx = cx - wx * newScale;
            view.ty = cy - wy * newScale;
            view.scale = newScale;
            draw();
        }, { passive: false });

        var dragging = false;
        var lastX = 0;
        var lastY = 0;
        var mouseDown = null;  // {x, y, mode} of the press, canvas-relative
        el.canvas.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            var rect = el.canvas.getBoundingClientRect();
            mouseDown = { x: e.clientX - rect.left, y: e.clientY - rect.top, mode: canvasMode };
            if (canvasMode === 'select') {
                // the drag becomes a rectangle select; panning is suspended
                rectDrag = { x0: mouseDown.x, y0: mouseDown.y, x1: mouseDown.x, y1: mouseDown.y };
                return;
            }
            dragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
            el.canvas.classList.add('viewer-dragging');
        });
        window.addEventListener('mousemove', function (e) {
            if (canvasMode === 'select' && rectDrag) {
                var rect = el.canvas.getBoundingClientRect();
                rectDrag.x1 = clamp(e.clientX - rect.left, 0, canvasW);
                rectDrag.y1 = clamp(e.clientY - rect.top, 0, canvasH);
                draw();
                return;
            }
            if (!dragging) return;
            view.tx += e.clientX - lastX;
            view.ty += e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            draw();
        });
        window.addEventListener('mouseup', function (e) {
            if (canvasMode === 'select' && rectDrag) {
                mouseDown = null;
                finishRectSelect();
                return;
            }
            var down = mouseDown;
            mouseDown = null;
            dragging = false;
            el.canvas.classList.remove('viewer-dragging');
            if (!down) return;
            var rect = el.canvas.getBoundingClientRect();
            var cx = clamp(e.clientX - rect.left, 0, canvasW);
            var cy = clamp(e.clientY - rect.top, 0, canvasH);
            var moved = Math.abs(cx - down.x) + Math.abs(cy - down.y);
            if (moved > CLICK_SLOP) return;  // a pan drag, not a click
            if (down.mode === 'add') addPointAtClick(cx, cy);
            else if (down.mode === 'select') selectPointAtClick(cx, cy);
            else if (down.mode === 'classify') classifyPointAtClick(cx, cy);
        });
        el.canvas.addEventListener('dblclick', function (e) {
            e.preventDefault();
            fitView();
        });
    }

    // ------------------------------------------------------------------
    // File browser modal glue
    // ------------------------------------------------------------------

    window.addEventListener('message', function (event) {
        var data = event.data || {};
        if (!data.selectedPath) return;
        if (data.fieldId === 'viewer-image-path') {
            addImageLayer(data);
        } else if (data.fieldId === 'viewer-points-path') {
            addPointsLayer(data);
        }
    });

    // ------------------------------------------------------------------
    // Init
    // ------------------------------------------------------------------

    function init() {
        el.canvas = $('viewerCanvas');
        el.canvasWrap = $('viewerCanvasWrap');
        el.hint = $('viewerHint');
        el.layerList = $('layerList');
        el.layerCount = $('layerCount');
        el.zRow = $('zSliderRow');
        el.zSlider = $('zSlider');
        el.zValue = $('zValue');
        el.contrastRow = $('contrastRow');
        el.contrastMin = $('contrastMinSlider');
        el.contrastMax = $('contrastMaxSlider');
        el.contrastMinValue = $('contrastMinValue');
        el.contrastMaxValue = $('contrastMaxValue');
        el.contrastFill = $('contrastFill');
        el.toolsPanel = $('viewerTools');
        el.toolsNote = $('toolsNote');
        el.pointsTools = $('pointsTools');
        el.toolAdd = $('toolAddPoints');
        el.toolSelect = $('toolSelectPoints');
        el.toolClassify = $('toolClassifyPoints');
        el.toolDelete = $('toolDeleteSelected');
        el.selectSubPanel = $('selectSubPanel');
        el.classifySubPanel = $('classifySubPanel');
        el.additiveToggle = $('additiveSelectToggle');
        el.classCountInput = $('classCountInput');
        el.classColorList = $('classColorList');
        el.nnTrain = $('nnTrainBtn');
        el.nnPredict = $('nnPredictBtn');
        el.nnStatus = $('nnStatus');
        if (!el.canvas || !el.layerList) return;
        ctx = el.canvas.getContext('2d');

        if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(function () { resizeCanvas(); }).observe(el.canvasWrap);
        } else {
            window.addEventListener('resize', resizeCanvas);
        }

        resizeCanvas();
        renderLayerList();
        showDefaultHint();
        syncSliders();
        renderToolsPanel();
        attachCanvasEvents();
        attachPanelEvents();
        attachSliderEvents();
        attachToolsEvents();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
