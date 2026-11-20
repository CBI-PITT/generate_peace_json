// PEACE Viewer: image, points and labels layers rendered on a single canvas.
//
// Layers (bottom -> top in add order):
// - image: a standalone .tif/.tiff file or a folder of tiffs (z-stack). Slices
//   are fetched and decoded lazily through the file browser blueprint
//   (/browser/dir/ serves file bytes with HTTP range support, /browser/dir_json/
//   lists folder contents). TIFFs are opened via GeoTIFF.fromUrl, so tiled
//   tiffs transfer only the tiles the current view needs (206 range requests);
//   zoomed-in views additionally read only the visible window of each plane.
//   Single-strip uncompressed tiffs fall back to whole-plane reads — the
//   atomic unit is the strip. A multi-page single TIFF also acts as a z-stack.
// - points: a CSV with napari-like coordinates — header columns 'axis-0' /
//   'axis-1' / 'axis-2' or 'z' / 'y' / 'x' (3 columns overlay the z-stack,
//   2 columns are a 2D image), falling back to positional z,y,x / y,x order.
// - labels: 256x256 sparse tiles matched to an image stack. Open OME-Zarr
//   groups or TIFF masks; export an OME-Zarr group on the server. An annotation
//   bit distinguishes painted background (0) from unannotated zeros.
//
// Paths arrive via the shared file browser modal (browser_modal.html +
// browser_picker.js): the postMessage payload is
// {fieldId, selectedPath, fileName, nextBrowserPath} where fieldId is
// 'viewer-image-path', 'viewer-points-path' or 'viewer-labels-path'.

(function () {
    'use strict';

    var SLICE_CACHE_MAX = 8;   // decoded raw slices kept per image layer
    var PAINT_CACHE_MAX = 8;   // rendered (contrast-applied) canvases per layer
    // Windowed reads: zoomed-in views (the plane does not fit the viewport)
    // read only the visible window of a plane; tiled tiffs then fetch only
    // the tiles the window intersects. The window is quantized to a fixed
    // grid so small pans/zooms reuse the same cache entry.
    var TILE_GRID = 512;             // quantization grid (px), matches 512px tiles
    var SLICE_CACHE_BYTES = 400 * 1024 * 1024;  // raw 16-bit + painted RGBA estimate
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
    var LABEL_TILE = 256;
    var BACKGROUND_COLOR = '#b8c7d9';

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
    var labelsPanelMode = null; // 'draw' | 'segment'
    var labelsBrush = 'brush';   // 'brush' | 'eraser'
    var labelsStroke = null;
    var pendingLayerType = null;
    var pendingExportLayerId = null;
    var labelsJob = null;

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

    // Slice cache key: the plain z for a full-plane read, 'z@x0,y0,x1,y1'
    // for a windowed read (bounds quantized to the tile grid upstream).
    // Full-plane entries keep integer keys, matching the classifier code
    // that looks slices up by z.
    function sliceKey(z, win) {
        if (!win) return z;
        return z + '@' + win[0] + ',' + win[1] + ',' + win[2] + ',' + win[3];
    }

    // The z of a slice cache key (full-plane integer keys and 'z@...' keys).
    function keyZ(key) {
        var s = String(key);
        var at = s.indexOf('@');
        return at === -1 ? Number(s) : Number(s.slice(0, at));
    }

    // An AbortError-shaped error: the viewer treats these as cancellation
    // (no failed mark, no error hint — the next draw retries).
    function abortedError(msg) {
        var e = new Error(msg || 'aborted');
        e.name = 'AbortError';
        return e;
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
        if (active && active.type === 'labels') return labelsImage(active);
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
    // points (z null) always participate. Point z values are continuous
    // coordinates from the source CSV (registration/resampling steps like
    // 0.5 or 0.666 of a plane), so they are snapped to the nearest image
    // plane for every comparison.
    function pointEligible(p, viewZ) {
        return p.z === null || viewZ === null || Math.round(p.z) === viewZ;
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
    // sliceW/sliceH are the dims of the requested read (full plane or window);
    // they are authoritative — a windowed read must not inherit the full
    // image dims from image.getWidth()/getHeight().
    function normalizeRasters(image, rasters, sliceW, sliceH) {
        var width = sliceW || image.getWidth();
        var height = sliceH || image.getHeight();
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

    // Read one z plane (full or windowed) from the layer's tiff source.
    // The browser blueprint serves file bytes with HTTP range support, so
    // geotiff fetches only the IFD plus the strips/tiles the read needs (206
    // partial responses). Folder mode opens a FRESH geotiff source per read:
    // geotiff 2.0.4's block bookkeeping is not abort-safe, and a source
    // poisoned by an aborted read makes every later read of that plane fail
    // with "Block X is not in the block requests" (verified on real tiled
    // data) — a fresh source per read keeps aborts clean. File mode keeps one
    // source (its page IFDs are expensive to re-fetch) but re-opens it after
    // any aborted read (ensureSlice drops layer.tiff on cancellation).
    // readRasters is called WITHOUT an abort signal on purpose: aborting a
    // geotiff read mid-flight corrupts its block bookkeeping ("Block X is not
    // in the block requests"). Instead the slice's own abort flag is checked
    // AFTER the source opens (before the big window transfer starts) and
    // again after the read — a superseded slice wastes only its header bytes
    // and its result is discarded, so the source stays healthy and every
    // slice settles. `window` is [x0, y0, x1, y1] in image pixels (top-left
    // origin) or null for a full-plane read.
    async function readSliceRaw(layer, z, signal, window) {
        var image;
        if (layer.mode === 'file') {
            if (!layer.tiff) {
                layer.tiff = await GeoTIFF.fromUrl(layer.fileUrl);
            }
            image = await layer.tiff.getImage(z);
        } else {
            var tiff = await GeoTIFF.fromUrl(layer.urls[z]);
            image = await tiff.getImage(0);
        }
        // superseded while the source was opening: bail out before the big
        // window transfer starts (only the header bytes were wasted)
        if (signal && signal.aborted) {
            throw abortedError('slice superseded while opening');
        }
        var fullWidth = image.getWidth();
        var fullHeight = image.getHeight();
        if (fullWidth <= 0 || fullHeight <= 0) throw new Error('image has no pixels');
        // storage format for the performance hint: a single strip is the
        // atomic unit of every read, so zoomed views cannot fetch less than
        // the whole image (tiled files read per-tile instead)
        if (!layer.singleStrip) {
            var fd = image.getFileDirectory();
            var tiled = fd.TileWidth !== undefined && fd.TileWidth !== null;
            if (!tiled && (fd.StripOffsets || []).length === 1) layer.singleStrip = true;
        }
        var win = null;
        if (window) {
            win = [
                clamp(Math.floor(window[0]), 0, fullWidth),
                clamp(Math.floor(window[1]), 0, fullHeight),
                clamp(Math.ceil(window[2]), 0, fullWidth),
                clamp(Math.ceil(window[3]), 0, fullHeight)
            ];
            if (win[2] <= win[0] || win[3] <= win[1]) win = null;
        }
        var width;
        var height;
        var rasters;
        if (win) {
            width = win[2] - win[0];
            height = win[3] - win[1];
            rasters = await image.readRasters({ window: win });
        } else {
            width = fullWidth;
            height = fullHeight;
            rasters = await image.readRasters();
        }
        // superseded while reading: discard the result (the caller re-requests)
        if (signal && signal.aborted) {
            throw abortedError('slice superseded while reading');
        }
        var slice = normalizeRasters(image, rasters, width, height);
        slice.ox = win ? win[0] : 0;
        slice.oy = win ? win[1] : 0;
        slice.fullWidth = fullWidth;
        slice.fullHeight = fullHeight;
        slice.bytes = width * height * 6;  // raw 16-bit + painted RGBA estimate
        return slice;
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

    function paintSlice(layer, key) {
        var raw = layer.slices.get(key);
        if (!raw) return;
        var canvas = renderSliceCanvas(raw, layer.contrast.min, layer.contrast.max);
        setLru(layer.paint, key, { canvas: canvas, cmin: layer.contrast.min, cmax: layer.contrast.max,
                                   ox: raw.ox || 0, oy: raw.oy || 0 }, cacheCap(layer));
    }

    // Cache caps: a count-based cap would hold ~1GB for 4067x5119 16-bit
    // slices (raw + painted RGBA), so the painted-cache cap is derived from a
    // byte budget per layer once the slice dimensions are known.
    function cacheCap(layer) {
        if (!layer.sliceBytes) return SLICE_CACHE_MAX;
        return Math.max(2, Math.min(SLICE_CACHE_MAX, Math.floor(SLICE_CACHE_BYTES / layer.sliceBytes)));
    }

    // Slice cache eviction: a byte budget shared by full-plane and windowed
    // slices (each entry carries its own approximate size), with a small
    // floor so the current view always fits.
    function setSliceCache(layer, key, slice) {
        if (layer.slices.has(key)) layer.slices.delete(key);
        layer.slices.set(key, slice);
        var total = 0;
        layer.slices.forEach(function (s) { total += (s.bytes || 0); });
        while (total > SLICE_CACHE_BYTES && layer.slices.size > 2) {
            var oldestKey = layer.slices.keys().next().value;
            var oldest = layer.slices.get(oldestKey);
            total -= (oldest.bytes || 0);
            layer.slices.delete(oldestKey);
        }
    }

    // Abort in-flight slice fetches for other z positions: dragging the z
    // slider across a large stack would otherwise queue a 40MB+ download per
    // position it passes. Keys carry their z (full-plane integer keys and
    // 'z@...' windowed keys), so windowed entries are covered too.
    function abortStaleSliceFetches(layer, keepZ) {
        if (!layer.inflight) return;
        layer.inflight.forEach(function (ctrl, key) {
            if (keyZ(key) !== keepZ) {
                layer.inflight.delete(key);
                ctrl.abort();
            }
        });
    }

    // Abort stale WINDOWED fetches of one z whose view window no longer
    // matches (a pan/zoom crossed a quantization grid boundary). Full-plane
    // fetches of the same z are kept — they initialize the contrast range
    // and serve fit-view.
    function abortStaleWindowFetches(layer, z, keepKey) {
        if (!layer.inflight) return;
        layer.inflight.forEach(function (ctrl, key) {
            if (key === keepKey) return;
            var s = String(key);
            if (s.indexOf('@') === -1) return;  // full-plane fetch: keep
            if (keyZ(key) !== z) return;        // other z: z-slider logic aborts these
            layer.inflight.delete(key);
            ctrl.abort();
        });
    }

    // Lazily fetch + decode one z plane (full or windowed), then render it
    // with the current contrast window. In-flight requests are deduplicated
    // per layer and cache key, and failed slices are never auto-retried (a
    // draw()/fitView() pass would otherwise re-trigger the fetch forever and
    // freeze the page). The contrast range is initialized from a full-plane
    // read only — a windowed read would estimate the range from the window.
    function ensureSlice(layer, z, window) {
        var key = sliceKey(z, window);
        if (layer.failed.has(key) || layer.slices.has(key) || layer.loading.has(key)) return;
        layer.loading.set(key, true);
        var ctrl = new AbortController();
        layer.inflight.set(key, ctrl);
        readSliceRaw(layer, z, ctrl.signal, window)
            .then(function (slice) {
                if (!layer.fullWidth) {
                    layer.fullWidth = slice.fullWidth;
                    layer.fullHeight = slice.fullHeight;
                }
                if (!layer.sliceBytes) {
                    layer.sliceBytes = layer.fullWidth * layer.fullHeight * 6;  // raw 16-bit + painted RGBA
                }
                if (!layer.dataRange && !window) initSliceRange(layer, slice);
                if (layer.singleStrip && !layer.formatHintShown) {
                    layer.formatHintShown = true;
                    showHint('This TIFF is stored as a single strip — zoomed-in views still download the ' +
                             'whole image. Convert with "Compressed and tiled tiffs" for fast zooming.', 'muted');
                }
                setSliceCache(layer, key, slice);
            })
            .then(function () { paintSlice(layer, key); })
            .catch(function (err) {
                // Cancellation must never mark the slice failed: the slice's
                // own abort, geotiff's abort-induced block-request corruption
                // ("Block X is not in the block requests"), or any error while
                // the slice's abort flag is set are all retryable — the next
                // draw re-requests the slice and the image recovers. File mode
                // re-opens its shared tiff source, which an aborted read can
                // leave in a bad state.
                if ((err && err.name === 'AbortError') || ctrl.signal.aborted ||
                    (err && String(err.message).indexOf('is not in the block requests') !== -1)) {
                    if (layer.mode === 'file') layer.tiff = null;
                    return;
                }
                layer.failed.add(key);
                showHint('Failed to load slice ' + z + ' of ' + layer.name + ': ' + err.message, 'error');
            })
            .finally(function () {
                layer.inflight.delete(key);
                layer.loading.delete(key);
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

    function activeLabelsLayer() {
        var layer = layerById(activeLayerId);
        return layer && layer.type === 'labels' ? layer : null;
    }

    function labelsImage(layer) {
        var image = layerById(layer.imageId);
        return image && image.ready && image.visible ? image : null;
    }

    function labelsKey(z, ty, tx) { return z + ':' + ty + ':' + tx; }

    function labelsTile(layer, z, ty, tx, create) {
        var key = labelsKey(z, ty, tx);
        var tile = layer.tiles.get(key);
        if (!tile && create) {
            tile = { values: new Uint16Array(LABEL_TILE * LABEL_TILE),
                     manual: new Uint8Array(LABEL_TILE * LABEL_TILE),
                     pred: new Uint8Array(LABEL_TILE * LABEL_TILE), version: 0 };
            layer.tiles.set(key, tile);
        }
        return tile;
    }

    function newLabelsLayer(name) {
        var image = referenceImageLayer();
        if (!image || !image.ready || !image.fullWidth || !image.fullHeight) {
            errorHint('Load an image slice before creating or opening labels.');
            return null;
        }
        var layer = makeLayer('labels', name);
        layer.imageId = image.id;
        layer.width = image.fullWidth;
        layer.height = image.fullHeight;
        layer.zCount = image.zCount;
        layer.tiles = new Map();
        layer.loadedTiles = new Set();
        layer.pendingTiles = new Set();
        layer.loadedPlanes = new Set();
        layer.failedPlanes = new Set();
        layer.loadingPlanes = new Map();
        layer.manifest = new Set();
        layer.colors = { 1: CLASS_COLORS[0] };
        layer.number = 1;
        layer.size = 12;
        var stem = name.replace(/\.ome\.zarr$/i, '').replace(/\.tiff?$/i, '')
            .replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[^A-Za-z0-9]+/, '') || 'labels';
        layer.exportName = stem + '.ome.zarr';
        layers.push(layer);
        activeLayerId = layer.id;
        canvasMode = 'none';
        labelsPanelMode = null;
        renderLayerList();
        syncSliders();
        renderToolsPanel();
        draw();
        return layer;
    }

    function addEmptyPointsLayer() {
        var image = referenceImageLayer();
        var layer = makeLayer('points', 'Untitled points');
        layer.coords = [];
        layer.hasZ = !!(image && image.zCount > 1);
        layer.classified = false;
        layer.classCount = 2;
        layers.push(layer);
        activeLayerId = layer.id;
        canvasMode = 'none';
        renderLayerList();
        renderToolsPanel();
        draw();
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
        layer.fileUrl = null;  // file mode: the layer's own tif URL (re-open after aborts)
        layer.ready = false;  // flipped once the tiff/pages or folder listing resolve
        layer.sliceBytes = 0; // approximate bytes per full-plane cached slice (raw + painted)
        layer.fullWidth = 0;  // full image dims (first decoded slice / page 0)
        layer.fullHeight = 0;
        layer.singleStrip = false;    // detected storage format (performance hint)
        layer.formatHintShown = false;
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
                // range-based open: only the IFD chain is fetched here, each
                // page's pixels load on demand (206 partial responses). The
                // source is reused across page reads but re-opened after any
                // aborted read (ensureSlice drops layer.tiff on cancellation).
                layer.fileUrl = fileUrlFor(msg);
                layer.tiff = await GeoTIFF.fromUrl(layer.fileUrl);
                layer.zCount = await layer.tiff.getImageCount();
                var img0 = await layer.tiff.getImage(0);
                layer.fullWidth = img0.getWidth();
                layer.fullHeight = img0.getHeight();
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
                    return { z: p.z, y: p.y, x: p.x, c: null, pred: false, sel: false };
                });
                if (coords.length === 0) throw new Error('no coordinate rows found');
                var layer = makeLayer('points', name);
                layer.coords = coords;
                layer.hasZ = coords.some(function (p) { return p.z !== null; });
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
        var removed = layers[idx];
        layers.splice(idx, 1);
        if (labelsJob && labelsJob.layerId === id) labelsJob.cancel();
        if (removed.type === 'image') {
            var jobLayer = labelsJob && layerById(labelsJob.layerId);
            if (jobLayer && jobLayer.imageId === id) labelsJob.cancel();
            layers = layers.filter(function (layer) { return layer.imageId !== id; });
        }
        if (!layerById(activeLayerId)) {
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
        canvasMode = 'none';
        labelsPanelMode = null;
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
        typeIcon.className = 'bi ' + (layer.type === 'image' ? 'bi-image' :
                                      layer.type === 'labels' ? 'bi-grid-3x3' : 'bi-record-circle') + ' viewer-layer-type';
        typeIcon.title = layer.type === 'image' ? 'Image layer' : layer.type === 'labels' ? 'Labels layer' : 'Points layer';

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
        if (layer.type === 'labels') {
            var saveLi = document.createElement('li');
            var save = document.createElement('button');
            save.type = 'button';
            save.className = 'dropdown-item';
            save.dataset.action = 'save-labels';
            save.textContent = 'Save OME-Zarr to folder';
            saveLi.appendChild(save);
            menu.appendChild(saveLi);
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
                    syncSliders();
                    renderToolsPanel();
                    draw();
                } else if (actionEl.dataset.action === 'export') {
                    exportPointsCsv(layer);
                } else if (actionEl.dataset.action === 'save-labels') {
                    startLabelsExport(layer);
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
                if (type === 'image') {
                    openFileBrowser('viewer-image-path');
                    return;
                }
                if (type === 'labels' && !referenceImageLayer()) {
                    errorHint('Load an image before adding a labels layer.');
                    return;
                }
                pendingLayerType = type;
                el.newLayerTitle.textContent = type === 'labels' ? 'Add labels layer' : 'Add points layer';
                bootstrap.Modal.getOrCreateInstance(el.newLayerModal).show();
            });
        });
        el.openLayer.addEventListener('click', function () {
            bootstrap.Modal.getOrCreateInstance(el.newLayerModal).hide();
            openFileBrowser(pendingLayerType === 'labels' ? 'viewer-labels-path' : 'viewer-points-path');
        });
        el.emptyLayer.addEventListener('click', function () {
            bootstrap.Modal.getOrCreateInstance(el.newLayerModal).hide();
            if (pendingLayerType === 'labels') newLabelsLayer('Untitled labels');
            else if (pendingLayerType === 'points') addEmptyPointsLayer();
        });
    }

    // ------------------------------------------------------------------
    // Sparse labels: lazy Zarr/TIFF import, painting and OME-Zarr export
    // ------------------------------------------------------------------

    async function labelsJson(url, data) {
        var response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                          body: JSON.stringify(data) });
        if (!response.ok) {
            var error = await response.text();
            throw new Error('HTTP ' + response.status + ': ' + error.slice(0, 160));
        }
        return response.json();
    }

    async function addLabelsFromSelection(msg) {
        var path = msg.selectedPath;
        var name = msg.fileName || basename(path);
        if (recentDuplicate('labels', name)) return;
        var layer = newLabelsLayer(name);
        if (!layer) return;
        layer.sourceLoading = true;
        renderToolsPanel();
        try {
            if (/\.zarr$/i.test(path)) {
                var info = await labelsJson('/viewer/labels/info', { path: path });
                var shape = info.shape;
                if (shape[1] !== layer.height || shape[2] !== layer.width ||
                    (shape[0] !== layer.zCount && shape[0] !== 1)) {
                    throw new Error('Labels dimensions do not match the image');
                }
                layer.source = { type: 'zarr', path: path, single: shape[0] === 1 };
                layer.sourceZ = shape[0] === 1 ? labelsImage(layer).z : null;
                (info.tiles || []).forEach(function (key) {
                    var parts = key.split(':');
                    var z = layer.sourceZ === null ? Number(parts[0]) : layer.sourceZ;
                    layer.manifest.add(labelsKey(z, parts[1], parts[2]));
                });
                (info.colors || []).forEach(function (entry) {
                    var rgba = entry.rgba;
                    if (entry['label-value'] > 0 && rgba && rgba.length >= 3) {
                        layer.colors[entry['label-value']] = '#' + rgba.slice(0, 3).map(function (v) {
                            return Math.round(v).toString(16).padStart(2, '0');
                        }).join('');
                    }
                });
            } else {
                if (typeof GeoTIFF === 'undefined') throw new Error('geotiff.js is needed for TIFF labels');
                var urls;
                if (isTiffPath(path)) {
                    urls = [fileUrlFor(msg)];
                } else {
                    var listing = await fetch(folderListingUrlFor(msg));
                    if (!listing.ok) throw new Error('Could not list TIFF labels folder');
                    var files = await listing.json();
                    urls = (files.files || []).filter(function (url) { return isTiffPath(url); });
                    if (!urls.length) throw new Error('No TIFF masks found');
                }
                var tiff = await GeoTIFF.fromUrl(urls[0]);
                var pages = urls.length === 1 ? await tiff.getImageCount() : urls.length;
                if (pages !== 1 && pages !== layer.zCount) throw new Error('TIFF z count does not match the image');
                var image0 = await tiff.getImage(0);
                if (image0.getWidth() !== layer.width || image0.getHeight() !== layer.height ||
                    image0.getSamplesPerPixel() !== 1) throw new Error('TIFF mask dimensions/channels do not match the image');
                layer.source = { type: 'tiff', urls: urls, tiff: tiff, pages: pages };
                layer.sourceZ = pages === 1 ? labelsImage(layer).z : null;
            }
            if (!layerById(layer.id)) return;
            layer.sourceLoading = false;
            renderToolsPanel();
            draw();
            showHint('Opened labels ' + name + '.');
        } catch (err) {
            removeLayer(layer.id);
            errorHint('Could not open labels: ' + err.message);
        }
    }

    async function loadTiffLabelsPlane(layer, z) {
        if (layer.loadedPlanes.has(z)) return;
        if (layer.loadingPlanes.has(z)) return layer.loadingPlanes.get(z);
        if (layer.sourceZ !== null && layer.sourceZ !== z) return;
        var work = (async function () {
            var source = layer.source;
            var tiff = source.urls.length === 1 ? source.tiff : await GeoTIFF.fromUrl(source.urls[z]);
            var image = await tiff.getImage(source.pages === 1 || source.urls.length > 1 ? 0 : z);
            if (image.getWidth() !== layer.width || image.getHeight() !== layer.height ||
                image.getSamplesPerPixel() !== 1) throw new Error('TIFF plane dimensions/channels do not match');
            var data = await image.readRasters();
            var plane = Array.isArray(data) ? data[0] : data;
            for (var y = 0; y < layer.height; y++) {
                for (var x = 0; x < layer.width; x++) {
                    var value = plane[y * layer.width + x];
                    if (!value) continue; // TIFF zero is unannotated, not manual background
                    if (!Number.isInteger(value) || value < 0 || value > 65535) {
                        throw new Error('TIFF labels must be unsigned integers up to 65535');
                    }
                    var tile = labelsTile(layer, z, Math.floor(y / LABEL_TILE), Math.floor(x / LABEL_TILE), true);
                    var idx = (y % LABEL_TILE) * LABEL_TILE + (x % LABEL_TILE);
                    tile.values[idx] = value;
                    tile.manual[idx] = 1;
                    if (!layer.colors[value]) layer.colors[value] = labelsColor(layer, value);
                }
            }
            layer.loadedPlanes.add(z);
            if (layerById(layer.id)) { renderToolsPanel(); draw(); }
        })();
        layer.loadingPlanes.set(z, work);
        try { await work; }
        catch (err) { layer.failedPlanes.add(z); throw err; }
        finally { layer.loadingPlanes.delete(z); }
    }

    async function ensureLabelsTile(layer, z, ty, tx, create) {
        var key = labelsKey(z, ty, tx);
        if (layer.source && layer.source.type === 'tiff') await loadTiffLabelsPlane(layer, z);
        if (layer.source && layer.source.type === 'zarr' && layer.manifest.has(key) &&
            !layer.loadedTiles.has(key)) {
            if (layer.pendingTiles.has(key)) return layer.pendingTiles.get(key);
            var work = (async function () {
                var response = await fetch('/viewer/labels/tile', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: layer.source.path, z: layer.source.single ? 0 : z,
                                           ty: ty, tx: tx })
                });
                if (!response.ok) throw new Error('Failed to load label tile (HTTP ' + response.status + ')');
                var raw = await response.arrayBuffer();
                if (raw.byteLength !== LABEL_TILE * LABEL_TILE * 3) throw new Error('Invalid label tile');
                var tile = labelsTile(layer, z, ty, tx, true);
                tile.values.set(new Uint16Array(raw.slice(0, LABEL_TILE * LABEL_TILE * 2)));
                tile.manual.set(new Uint8Array(raw.slice(LABEL_TILE * LABEL_TILE * 2)));
                layer.loadedTiles.add(key);
                if (layerById(layer.id)) { draw(); renderToolsPanel(); }
                return tile;
            })();
            layer.pendingTiles.set(key, work);
            try { return await work; } finally { layer.pendingTiles.delete(key); }
        }
        return labelsTile(layer, z, ty, tx, create);
    }

    function labelsColor(layer, n) {
        return n === 0 ? (layer.colors[0] || BACKGROUND_COLOR) :
            (layer.colors[n] || CLASS_COLORS[(n - 1) % MAX_CLASSES]);
    }

    function paintLabelsTile(layer, tile) {
        if (tile.paint && tile.paintVersion === tile.version && tile.paletteVersion === layer.paletteVersion) {
            return tile.paint;
        }
        // Manual annotations render at full overlay strength; model
        // predictions (including predicted background) at a lighter one so
        // the two stay distinguishable. Predicted state is per-session only.
        var pixels = new Uint8ClampedArray(LABEL_TILE * LABEL_TILE * 4);
        var colorCache = {};
        for (var i = 0; i < tile.values.length; i++) {
            var n = tile.values[i];
            var predicted = tile.pred[i] && !tile.manual[i];
            if (!tile.manual[i] && !predicted && !n) continue;
            if (!colorCache[n]) {
                var c = labelsColor(layer, n);
                colorCache[n] = [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16),
                                 parseInt(c.slice(5, 7), 16)];
            }
            var o = i * 4;
            pixels[o] = colorCache[n][0];
            pixels[o + 1] = colorCache[n][1];
            pixels[o + 2] = colorCache[n][2];
            pixels[o + 3] = predicted ? 80 : 145;
        }
        var canvas = document.createElement('canvas');
        canvas.width = canvas.height = LABEL_TILE;
        canvas.getContext('2d').putImageData(new ImageData(pixels, LABEL_TILE, LABEL_TILE), 0, 0);
        tile.paint = canvas;
        tile.paintVersion = tile.version;
        tile.paletteVersion = layer.paletteVersion;
        return canvas;
    }

    function drawLabelsLayer(layer) {
        var image = labelsImage(layer);
        if (!image) return;
        var z = image.z;
        if (layer.source && layer.source.type === 'tiff' && !layer.loadedPlanes.has(z)) {
            if (layer.failedPlanes.has(z)) return;
            if (!layer.loadingPlanes.has(z)) loadTiffLabelsPlane(layer, z).catch(function (err) {
                errorHint(err.message);
            });
            return;
        }
        var x0 = Math.max(0, Math.floor(-view.tx / view.scale / LABEL_TILE));
        var y0 = Math.max(0, Math.floor(-view.ty / view.scale / LABEL_TILE));
        var x1 = Math.min(Math.ceil(layer.width / LABEL_TILE), Math.ceil((canvasW - view.tx) / view.scale / LABEL_TILE));
        var y1 = Math.min(Math.ceil(layer.height / LABEL_TILE), Math.ceil((canvasH - view.ty) / view.scale / LABEL_TILE));
        layer.manifest.forEach(function (key) {
            var parts = key.split(':').map(Number);
            if (parts[0] === z && parts[1] >= y0 && parts[1] < y1 && parts[2] >= x0 && parts[2] < x1 &&
                !layer.loadedTiles.has(key) && !layer.pendingTiles.has(key)) {
                ensureLabelsTile(layer, z, parts[1], parts[2], false).catch(function (err) {
                    layer.loadedTiles.add(key); // no refetch loop on an invalid chunk
                    errorHint(err.message);
                });
            }
        });
        ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.tx, dpr * view.ty);
        ctx.imageSmoothingEnabled = false;
        layer.tiles.forEach(function (tile, key) {
            var parts = key.split(':').map(Number);
            if (parts[0] !== z || parts[1] < y0 || parts[1] >= y1 || parts[2] < x0 || parts[2] >= x1) return;
            ctx.drawImage(paintLabelsTile(layer, tile), parts[2] * LABEL_TILE, parts[1] * LABEL_TILE);
        });
    }

    function renderLabelsTools(layer) {
        var drawing = labelsPanelMode === 'draw';
        el.labelsDrawPanel.classList.toggle('d-none', !drawing);
        el.labelsSegmentPanel.classList.toggle('d-none', labelsPanelMode !== 'segment');
        el.labelsDrawBtn.classList.toggle('active', drawing);
        el.labelsSegmentBtn.classList.toggle('active', labelsPanelMode === 'segment');
        el.labelsDrawBtn.setAttribute('aria-pressed', String(drawing));
        el.labelsSegmentBtn.setAttribute('aria-pressed', String(labelsPanelMode === 'segment'));
        el.labelsDrawBtn.disabled = !!layer.sourceLoading;
        el.labelsSegmentBtn.disabled = !!layer.sourceLoading;
        el.labelsExport.disabled = !!layer.sourceLoading;
        el.labelsBrushBtn.classList.toggle('active', labelsBrush === 'brush');
        el.labelsEraserBtn.classList.toggle('active', labelsBrush === 'eraser');
        el.labelsBrushBtn.setAttribute('aria-pressed', String(labelsBrush === 'brush'));
        el.labelsEraserBtn.setAttribute('aria-pressed', String(labelsBrush === 'eraser'));
        el.canvasWrap.classList.toggle('viewer-mode-labels', drawing);
        el.labelsNumber.value = String(layer.number);
        el.labelsSize.value = String(layer.size);
        el.labelsSizeValue.textContent = String(layer.size);
        el.labelsColor.value = labelsColor(layer, layer.number);
        el.labelsExportName.value = layer.exportName;
        el.labelsTrain.disabled = !!layer.sourceLoading || !!labelsJob ||
            (!layer.tiles.size && !layer.manifest.size && !layer.source);
        el.labelsPredict.disabled = !!layer.sourceLoading || !!labelsJob || !layer.model;
        el.labelsStop.classList.toggle('d-none', !labelsJob || labelsJob.layerId !== layer.id);
        el.labelsStatus.textContent = layer.status || 'Paint foreground and background, then Train.';
    }

    function attachLabelsEvents() {
        el.labelsDrawBtn.addEventListener('click', function () {
            labelsPanelMode = labelsPanelMode === 'draw' ? null : 'draw';
            renderToolsPanel();
        });
        el.labelsSegmentBtn.addEventListener('click', function () {
            labelsPanelMode = labelsPanelMode === 'segment' ? null : 'segment';
            renderToolsPanel();
        });
        el.labelsBrushBtn.addEventListener('click', function () { labelsBrush = 'brush'; renderToolsPanel(); });
        el.labelsEraserBtn.addEventListener('click', function () { labelsBrush = 'eraser'; renderToolsPanel(); });
        el.labelsNumber.addEventListener('change', function () {
            var layer = activeLabelsLayer();
            if (!layer) return;
            layer.number = clamp(parseInt(el.labelsNumber.value, 10) || 0, 0, 65535);
            if (!layer.colors[layer.number]) layer.colors[layer.number] = labelsColor(layer, layer.number);
            renderToolsPanel();
        });
        el.labelsSize.addEventListener('input', function () {
            var layer = activeLabelsLayer();
            if (!layer) return;
            layer.size = Number(el.labelsSize.value);
            el.labelsSizeValue.textContent = String(layer.size);
        });
        el.labelsColor.addEventListener('input', function () {
            var layer = activeLabelsLayer();
            if (!layer) return;
            layer.colors[layer.number] = el.labelsColor.value;
            layer.paletteVersion = (layer.paletteVersion || 0) + 1;
            draw();
        });
        el.labelsExportName.addEventListener('input', function () {
            var layer = activeLabelsLayer();
            if (layer) layer.exportName = el.labelsExportName.value.trim();
        });
        el.labelsExport.addEventListener('click', function () { startLabelsExport(activeLabelsLayer()); });
        el.labelsTrain.addEventListener('click', trainLabels);
        el.labelsPredict.addEventListener('click', predictLabels);
        el.labelsStop.addEventListener('click', function () { if (labelsJob) labelsJob.cancel(); });
    }

    function startLabelsExport(layer) {
        if (!layer || !labelsImage(layer)) return;
        pendingExportLayerId = layer.id;
        openFileBrowser('viewer-labels-export-path');
    }

    async function exportLabels(layer, parent) {
        var token = null;
        try {
            // TIFF imports are decoded plane by plane; a sparse Zarr import
            // only needs the populated chunks listed in its manifest.
            if (layer.source && layer.source.type === 'tiff') {
                for (var z = 0; z < layer.zCount; z++) {
                    await loadTiffLabelsPlane(layer, z);
                    showHint('Reading TIFF masks: ' + (z + 1) + '/' + layer.zCount);
                }
            }
            var keys = new Set(layer.tiles.keys());
            layer.manifest.forEach(function (key) { keys.add(key); });
            var colors = Object.keys(layer.colors).map(function (n) {
                var hex = labelsColor(layer, Number(n));
                return { 'label-value': Number(n), rgba: [parseInt(hex.slice(1, 3), 16),
                    parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255] };
            });
            var result = await labelsJson('/viewer/labels/begin', {
                parent: parent, name: layer.exportName, shape: [layer.zCount, layer.height, layer.width], colors: colors
            });
            token = result.token;
            var done = 0;
            for (var key of keys) {
                var [zz, ty, tx] = key.split(':').map(Number);
                var tile = await ensureLabelsTile(layer, zz, ty, tx, false);
                done++;
                if (!tile) continue;
                var bytes = new Uint8Array(LABEL_TILE * LABEL_TILE * 3);
                bytes.set(new Uint8Array(tile.values.buffer), 0);
                bytes.set(tile.manual, LABEL_TILE * LABEL_TILE * 2);
                var url = '/viewer/labels/write_tile?token=' + encodeURIComponent(token) +
                    '&z=' + zz + '&ty=' + ty + '&tx=' + tx;
                var response = await fetch(url, { method: 'POST', body: bytes });
                if (!response.ok) throw new Error('Could not save tile ' + key + ' (HTTP ' + response.status + ')');
                showHint('Saving OME-Zarr: ' + done + '/' + keys.size + ' tiles');
            }
            var saved = await labelsJson('/viewer/labels/finish', { token: token });
            token = null;
            showHint('Saved ' + saved.path);
        } catch (err) {
            if (token) labelsJson('/viewer/labels/cancel', { token: token }).catch(function () {});
            errorHint('Could not save labels: ' + err.message);
        }
    }

    async function stampLabels(layer, z, x, y, erasing) {
        var radius = Math.max(0.75, layer.size / 2);
        var x0 = Math.max(0, Math.floor(x - radius));
        var x1 = Math.min(layer.width - 1, Math.ceil(x + radius));
        var y0 = Math.max(0, Math.floor(y - radius));
        var y1 = Math.min(layer.height - 1, Math.ceil(y + radius));
        for (var ty = Math.floor(y0 / LABEL_TILE); ty <= Math.floor(y1 / LABEL_TILE); ty++) {
            for (var tx = Math.floor(x0 / LABEL_TILE); tx <= Math.floor(x1 / LABEL_TILE); tx++) {
                var tile = await ensureLabelsTile(layer, z, ty, tx, true);
                for (var yy = Math.max(y0, ty * LABEL_TILE); yy <= Math.min(y1, (ty + 1) * LABEL_TILE - 1); yy++) {
                    for (var xx = Math.max(x0, tx * LABEL_TILE); xx <= Math.min(x1, (tx + 1) * LABEL_TILE - 1); xx++) {
                        if ((xx - x) ** 2 + (yy - y) ** 2 > radius * radius) continue;
                        var i = (yy % LABEL_TILE) * LABEL_TILE + (xx % LABEL_TILE);
                        tile.values[i] = erasing ? 0 : layer.number;
                        tile.manual[i] = erasing ? 0 : 1;
                        tile.pred[i] = 0;  // a stamped pixel is manual (or erased)
                    }
                }
                tile.version++;
            }
        }
        if (layerById(layer.id)) { draw(); renderToolsPanel(); }
    }

    function strokeLabels(layer, z, sx, sy) {
        var x = (sx - view.tx) / view.scale;
        var y = (sy - view.ty) / view.scale;
        if (!labelsStroke || labelsStroke.layer !== layer || labelsStroke.z !== z) return;
        var previous = labelsStroke.previous;
        var distance = previous ? Math.hypot(x - previous.x, y - previous.y) : 0;
        var steps = Math.max(1, Math.ceil(distance / Math.max(1, layer.size / 3)));
        var erasing = labelsStroke.erasing;
        labelsStroke.previous = { x: x, y: y };
        labelsStroke.work = labelsStroke.work.then(async function () {
            for (var s = previous ? 1 : 0; s <= steps; s++) {
                var t = s / steps;
                await stampLabels(layer, z, previous ? previous.x + (x - previous.x) * t : x,
                                  previous ? previous.y + (y - previous.y) * t : y, erasing);
            }
        }).catch(function (err) { errorHint('Could not draw labels: ' + err.message); });
    }

    // ------------------------------------------------------------------
    // Labels segmentation: worker-side neural net, current plane only
    // ------------------------------------------------------------------

    function labelsWorkerJob(layer) {
        var worker = new Worker(window.labelsWorkerUrl);
        var job = { layerId: layer.id, worker: worker, cancelled: false, reject: null };
        job.cancel = function () {
            job.cancelled = true;
            worker.terminate();
            if (job.reject) job.reject(new Error('Stopped'));
        };
        labelsJob = job;
        renderToolsPanel();
        return job;
    }

    function askLabelsWorker(job, message, transfer, onProgress) {
        if (job.cancelled) return Promise.reject(new Error('Stopped'));
        return new Promise(function (resolve, reject) {
            job.reject = reject;
            job.worker.onmessage = function (event) {
                if (event.data.progress) {
                    if (onProgress) onProgress(event.data);
                    return;
                }
                job.reject = null;
                if (event.data.error) reject(new Error(event.data.error));
                else resolve(event.data.result);
            };
            job.worker.onerror = function (error) {
                job.reject = null;
                reject(new Error(error.message || 'Segmentation worker failed'));
            };
            job.worker.postMessage(message, transfer || []);
        });
    }

    function labelsJobStatus(layer, text) {
        layer.status = text;
        if (activeLayerId === layer.id) renderToolsPanel();
    }

    function finishLabelsJob(job, layer) {
        job.worker.terminate();
        if (labelsJob === job) labelsJob = null;
        if (layerById(layer.id)) renderToolsPanel();
    }

    // A full-plane read is reused for single-strip TIFFs: reading hundreds of
    // small windows from a single-strip image would decompress the entire
    // plane hundreds of times. Tiled TIFFs use small haloed range reads.
    async function labelsImageTile(image, z, ty, tx, fullPlanes, signal) {
        if (image.singleStrip) {
            if (!fullPlanes.has(z)) {
                fullPlanes.set(z, image.slices.get(z) || await readSliceRaw(image, z, signal));
            }
            return fullPlanes.get(z);
        }
        var x0 = Math.max(0, tx * LABEL_TILE - 2);
        var y0 = Math.max(0, ty * LABEL_TILE - 2);
        var x1 = Math.min(image.fullWidth, (tx + 1) * LABEL_TILE + 2);
        var y1 = Math.min(image.fullHeight, (ty + 1) * LABEL_TILE + 2);
        return readSliceRaw(image, z, signal, [x0, y0, x1, y1]);
    }

    function imageFirstChannel(slice) {
        if (!slice.interleaved) return slice.data[0];
        var first = new slice.data.constructor(slice.width * slice.height);
        for (var i = 0; i < first.length; i++) first[i] = slice.data[i * slice.spp];
        return first;
    }

    // Mirror of the worker's featuresAt: a normalized 11x11 intensity patch
    // around the pixel (edge-clamped, halo-aware). No position features —
    // they let the model memorize localized stroke locations instead of
    // learning intensity patterns.
    function labelFeatures(slice, pixels, x, y, range) {
        var f = [];
        var span = (range.max - range.min) || 1;
        var half = 5;
        for (var dy = -half; dy <= half; dy++) {
            for (var dx = -half; dx <= half; dx++) {
                var sx = clamp(x + dx - (slice.ox || 0), 0, slice.width - 1);
                var sy = clamp(y + dy - (slice.oy || 0), 0, slice.height - 1);
                f.push((pixels[sy * slice.width + sx] - range.min) / span);
            }
        }
        return f;
    }

    function labelsRange(image) {
        // A fixed range for all planes, independent of the contrast handles.
        return image.contrastDomain || image.dataRange || { min: 0, max: 65535 };
    }

    async function trainLabels() {
        var layer = activeLabelsLayer();
        if (!layer || labelsJob) return;
        var image = labelsImage(layer);
        if (!image) { errorHint('Load the matching image first.'); return; }
        var job = labelsWorkerJob(layer);
        var fullPlanes = new Map();
        try {
            if (layer.source && layer.source.type === 'tiff') {
                for (var z = 0; z < layer.zCount; z++) {
                    if (job.cancelled) throw new Error('Stopped');
                    await loadTiffLabelsPlane(layer, z);
                    labelsJobStatus(layer, 'Reading TIFF labels: ' + (z + 1) + '/' + layer.zCount);
                }
            }
            var keys = new Set(layer.tiles.keys());
            layer.manifest.forEach(function (key) { keys.add(key); });
            var features = [], targets = [], classes = new Set();
            var range = labelsRange(image);
            var done = 0;
            for (var key of keys) {
                if (job.cancelled) throw new Error('Stopped');
                var [zz, ty, tx] = key.split(':').map(Number);
                var tile = await ensureLabelsTile(layer, zz, ty, tx, false);
                if (!tile || !tile.manual.some(function (m) { return m !== 0; })) continue;
                var raw = await labelsImageTile(image, zz, ty, tx, fullPlanes);
                var pixels = imageFirstChannel(raw);
                var tileHeight = Math.min(LABEL_TILE, layer.height - ty * LABEL_TILE);
                var tileWidth = Math.min(LABEL_TILE, layer.width - tx * LABEL_TILE);
                for (var yy = 0; yy < tileHeight; yy++) {
                    for (var xx = 0; xx < tileWidth; xx++) {
                        var i = yy * LABEL_TILE + xx;
                        if (!tile.manual[i]) continue;
                        var n = tile.values[i];
                        classes.add(n);
                        targets.push(n);
                var f = labelFeatures(raw, pixels, tx * LABEL_TILE + xx, ty * LABEL_TILE + yy, range);
                        for (var fi = 0; fi < f.length; fi++) features.push(f[fi]);
                    }
                }
                done++;
                labelsJobStatus(layer, 'Loading training patches: ' + done + '/' + keys.size + ' tiles');
            }
            if (!classes.has(0) || classes.size < 2) {
                throw new Error('Paint label 0 (background) and at least one foreground label before training.');
            }
            if (job.cancelled) throw new Error('Stopped');
            var xs = Float32Array.from(features);
            var ys = Uint16Array.from(targets);
            var result = await askLabelsWorker(job, { type: 'train', features: xs.buffer,
                targets: ys.buffer, classes: Array.from(classes).sort(function (a, b) { return a - b; }) },
            [xs.buffer, ys.buffer], function (progress) {
                labelsJobStatus(layer, 'Training: epoch ' + progress.progress + '/' + progress.total);
            });
            layer.model = result.model;
            layer.modelRange = range;
            labelsJobStatus(layer, 'Trained on all ' + result.count + ' manual pixels (' +
                            result.model.classes.length + ' labels, loss ' + result.loss.toFixed(3) + ').');
        } catch (err) {
            labelsJobStatus(layer, err.message);
            if (!job.cancelled) errorHint('Labels training: ' + err.message);
        } finally {
            finishLabelsJob(job, layer);
        }
    }

    async function predictLabels() {
        var layer = activeLabelsLayer();
        if (!layer || !layer.model || labelsJob) return;
        var image = labelsImage(layer);
        if (!image) return;
        var job = labelsWorkerJob(layer);
        var z = image.z; // snapshot: moving the slider cannot shift the target plane
        var fullPlanes = new Map();
        var total = Math.ceil(layer.width / LABEL_TILE) * Math.ceil(layer.height / LABEL_TILE);
        var done = 0;
        var predictedForeground = 0;
        try {
            for (var ty = 0; ty < Math.ceil(layer.height / LABEL_TILE); ty++) {
                for (var tx = 0; tx < Math.ceil(layer.width / LABEL_TILE); tx++) {
                    if (job.cancelled) throw new Error('Stopped');
                    var tile = await ensureLabelsTile(layer, z, ty, tx, true);
                    var slice = await labelsImageTile(image, z, ty, tx, fullPlanes);
                    var pixels = imageFirstChannel(slice);
                    // Transfer copies: live tiles and cached image slices remain intact.
                    var rawCopy = pixels.slice();
                    var valueCopy = tile.values.slice();
                    var manualCopy = tile.manual.slice();
                    var result = await askLabelsWorker(job, { type: 'predict', model: layer.model,
                        arrayType: rawCopy.constructor.name, raw: rawCopy.buffer,
                        values: valueCopy.buffer, manual: manualCopy.buffer,
                        width: slice.width, height: slice.height, ox: slice.ox || 0, oy: slice.oy || 0,
                        fullWidth: layer.width, fullHeight: layer.height, tx: tx, ty: ty,
                        tileWidth: Math.min(LABEL_TILE, layer.width - tx * LABEL_TILE),
                        tileHeight: Math.min(LABEL_TILE, layer.height - ty * LABEL_TILE),
                        range: layer.modelRange }, [rawCopy.buffer, valueCopy.buffer, manualCopy.buffer]);
                    tile.values.set(new Uint16Array(result.values));
                    for (var pi = 0; pi < tile.values.length; pi++) {
                        tile.pred[pi] = tile.manual[pi] ? 0 : 1;
                    }
                    tile.version++;
                    done++;
                    predictedForeground += result.foreground || 0;
                    labelsJobStatus(layer, 'Predicting z=' + z + ': ' + done + '/' + total + ' tiles');
                    if (image.z === z && layer.visible) draw();
                }
            }
            draw();  // final repaint even if the visible plane moved mid-pass
            labelsJobStatus(layer, 'Predicted z=' + z + ' (' + total + ' tiles, ' + predictedForeground +
                            ' foreground pixel' + (predictedForeground === 1 ? '' : 's') +
                            '). Manual pixels preserved.');
        } catch (err) {
            labelsJobStatus(layer, job.cancelled ? 'Stopped after ' + done + '/' + total + ' tiles.' : err.message);
            if (!job.cancelled) errorHint('Labels prediction: ' + err.message);
        } finally {
            finishLabelsJob(job, layer);
        }
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
            el.toolsNote.classList.toggle('d-none', !!activeLabelsLayer());
            el.pointsTools.classList.add('d-none');
            el.labelsTools.classList.toggle('d-none', !activeLabelsLayer());
            el.canvasWrap.classList.remove('viewer-mode-add', 'viewer-mode-select', 'viewer-mode-classify', 'viewer-mode-labels');
            if (activeLabelsLayer()) renderLabelsTools(activeLabelsLayer());
            return;
        }
        el.toolsNote.classList.add('d-none');
        el.pointsTools.classList.remove('d-none');
        el.labelsTools.classList.add('d-none');
        el.canvasWrap.classList.remove('viewer-mode-labels');
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

    // Train/Predict/Reset button state + model status line in the classify
    // sub-panel: Train needs a manually classified point anywhere in the
    // stack (its slice is loaded on demand), Reset needs a predicted point
    // on the current z plane, Predict needs a trained model. All three are
    // disabled while an async training pass is running.
    function updateNnControls(layer) {
        var ref = referenceImageLayer();
        var hasPredicted = false;
        if (ref) {
            hasPredicted = currentZPoints(layer, ref.z).some(function (p) { return p.pred; });
        }
        var hasManual = manualTrainingPoints(layer).some(function (p) {
            if (!ref) return false;
            if (p.z === null) return true;  // trains on the current plane
            return ref.zCount > 0 && p.z >= 0 && p.z < ref.zCount;
        });
        el.nnTrain.disabled = !hasManual || nnTraining;
        el.nnPredict.disabled = !layer.nn || nnTraining;
        el.nnReset.disabled = !hasPredicted || nnTraining;
        // Apply-to-all: needs a model and a predictable point on some z
        // plane; doubles as the Stop control while the pass runs.
        var hasApply = false;
        if (ref) {
            hasApply = layer.coords.some(function (p) {
                return p.z !== null && (!p.c || p.pred) && p.z >= 0 && p.z < ref.zCount;
            });
        }
        if (nnRunMode === 'predict-all') {
            setApplyButton(true);
            el.nnApply.disabled = nnStopRequested;
        } else {
            setApplyButton(false);
            el.nnApply.disabled = !layer.nn || !hasApply || nnTraining;
        }
        if (!ref) {
            el.nnStatus.textContent = 'Load an image layer — the training patches come from its slices.';
        } else if (layer.nn) {
            var zLabel = layer.nn.trainedZs && layer.nn.trainedZs.length ? nnZLabel(layer.nn.trainedZs) : '';
            el.nnStatus.textContent = 'Model: ' + zLabel + ' · ' + layer.nn.count +
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
            var predCount = 0;
            for (var i = 0; i < layer.coords.length; i++) {
                var p = layer.coords[i];
                if (p.c !== k) continue;
                if (p.pred) predCount++;
                else count++;
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
            badge.title = 'Manually classified points (training data)';
            row.appendChild(swatch);
            row.appendChild(label);
            row.appendChild(badge);
            if (predCount > 0) {
                var predBadge = document.createElement('span');
                predBadge.className = 'viewer-class-pred-badge text-muted';
                predBadge.textContent = predCount + ' pred';
                predBadge.title = 'Predicted points in this class';
                row.appendChild(predBadge);
            }
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
        el.nnReset.addEventListener('click', resetPredicted);
        el.nnApply.addEventListener('click', function () {
            if (nnRunMode === 'predict-all') stopPredictAll();
            else predictAllZ();
        });
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
        var z = layer.hasZ ? (ref ? ref.z : 0) : null;
        // new points start unclassified too (click to assign a class)
        layer.coords.push({ z: z, y: wy, x: wx, c: null, pred: false, sel: false });
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
        // a clicked point is manually classified from now on (joins the
        // next training set even when it was predicted before)
        p.c = nextClass(p.c, layer.classCount);
        p.pred = false;
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

    // Training data are the manually classified points of every z plane
    // (each point's intensity patch comes from its own slice, loaded on
    // demand); prediction runs on the current z plane only.
    var NN_PATCH = 10;      // 10x10 intensity patch around a point
    var NN_HIDDEN = 24;     // hidden layer width
    var NN_EPOCHS = 150;    // full-batch training epochs
    var NN_LR = 0.05;       // Adam learning rate
    var NN_NO_MODEL_TEXT = 'No model yet — classify some points, then Train.';
    var nnTraining = false;      // true while an async training/prediction pass runs
    var nnRunMode = null;        // 'train' | 'predict-all' while a pass is running
    var nnStopRequested = false; // Stop clicked during a predict-all pass
    var nnAbort = null;          // aborts the in-flight slice fetch of the pass

    // Points that participate on a z plane: 3-column points whose z matches
    // the plane plus every 2-column point (z null).
    function currentZPoints(layer, viewZ) {
        return layer.coords.filter(function (p) { return pointEligible(p, viewZ); });
    }

    // Manually classified points across all z planes (predicted points only
    // join after they are clicked).
    function manualTrainingPoints(layer) {
        return layer.coords.filter(function (p) { return p.c && !p.pred; });
    }

    // Compact label for a set of z planes: "z=3,5" for a few, "N z-planes"
    // once the list grows long.
    function nnZLabel(zs) {
        if (zs.length <= 3) return 'z=' + zs.join(',');
        return zs.length + ' z-planes';
    }

    // The first slice decoded by a pass initializes the shared data range,
    // exactly like ensureSlice does, so features are normalized identically
    // across z planes.
    function initSliceRange(ref, slice) {
        if (ref.dataRange) return;
        ref.dataRange = computeRange(slice);
        ref.float = !Number.isInteger(ref.dataRange.min) || !Number.isInteger(ref.dataRange.max);
        ref.contrastDomain = contrastDomain(slice, ref.dataRange);
        ref.contrast = { min: ref.dataRange.min, max: ref.dataRange.max };
        if (sliderImageLayer() === ref) syncSliders();
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

    // Train on the manually classified points of every z plane (predicted
    // points only join after they are clicked). Each point's intensity patch
    // comes from its own z slice: cached slices are reused, missing ones are
    // fetched + decoded on demand, and points whose z is outside the image
    // stack are skipped. Prediction still runs on the current z plane only.
    async function trainClassifier() {
        if (nnTraining) return;
        var layer = activePointsLayer();
        if (!layer || !layer.classified) {
            errorHint('Enter Classify mode and assign some classes first.');
            return;
        }
        var ref = referenceImageLayer();
        if (!ref) {
            errorHint('Load an image layer first — the training patches come from its slices.');
            return;
        }
        var usable = [];
        var skipped = 0;
        var pts = manualTrainingPoints(layer);
        for (var i = 0; i < pts.length; i++) {
            var z = pts[i].z === null ? ref.z : Math.round(pts[i].z);  // 2-col points train on the current plane
            if (z === null || z < 0 || z >= ref.zCount) {
                skipped++;
                continue;
            }
            usable.push({ point: pts[i], z: z });
        }
        if (usable.length === 0) {
            errorHint('No manually classified points — click points with the Classify tool first.');
            return;
        }
        nnTraining = true;
        nnRunMode = 'train';
        nnStopRequested = false;
        nnAbort = new AbortController();
        renderToolsPanel();
        showHint('Training on ' + usable.length + ' points…');
        try {
            // unique z values with manual points, ascending
            var zSeen = {};
            var zs = [];
            for (var u = 0; u < usable.length; u++) {
                var uz = usable[u].z;
                if (!zSeen[uz]) {
                    zSeen[uz] = true;
                    zs.push(uz);
                }
            }
            zs.sort(function (a, b) { return a - b; });

            // resolve one slice per z: cached ones are reused, the rest are
            // fetched + decoded now (large stacks may download several
            // slices, one per annotated z)
            var slices = {};
            for (var s = 0; s < zs.length; s++) {
                var sz = zs[s];
                if (ref.slices && ref.slices.has(sz)) {
                    slices[sz] = ref.slices.get(sz);
                    continue;
                }
                try {
                    var slice = await readSliceRaw(ref, sz, nnAbort.signal);
                    slices[sz] = slice;
                    initSliceRange(ref, slice);
                } catch (err) {
                    // a slice that fails to load skips its points
                    skipped += usable.filter(function (entry) { return entry.z === sz; }).length;
                }
            }
            if (!layerById(layer.id)) return;  // layer was deleted mid-training

            var entries = usable.filter(function (entry) { return !!slices[entry.z]; });
            if (entries.length === 0) {
                errorHint('Failed to load the slices needed for training.');
                return;
            }
            var classSet = {};
            var classes = [];
            for (var c2 = 0; c2 < entries.length; c2++) {
                var cv = entries[c2].point.c;
                if (!classSet[cv]) {
                    classSet[cv] = true;
                    classes.push(cv);
                }
            }
            var xs = [];
            var labels = [];
            for (var t = 0; t < entries.length; t++) {
                var entry = entries[t];
                xs.push(pointFeatures(slices[entry.z], entry.point, ref.dataRange));
                labels.push(classes.indexOf(entry.point.c));
            }
            var net = nnCreate(NN_PATCH * NN_PATCH + 2, NN_HIDDEN, classes.length);
            var loss = nnTrain(net, xs, labels, NN_EPOCHS, NN_LR);
            var trainedZs = [];
            var zSeenT = {};
            for (var t2 = 0; t2 < entries.length; t2++) {
                var ez = entries[t2].z;
                if (!zSeenT[ez]) {
                    zSeenT[ez] = true;
                    trainedZs.push(ez);
                }
            }
            trainedZs.sort(function (a, b) { return a - b; });
            layer.nn = { net: net, classes: classes, trainedZs: trainedZs,
                         count: entries.length, loss: loss };
            var skipNote = skipped > 0 ? ' Skipped ' + skipped + ' point' + (skipped === 1 ? '' : 's') + '.' : '';
            showHint('Trained on ' + entries.length + ' points (' + nnZLabel(trainedZs) + ', ' + classes.length +
                     ' class' + (classes.length === 1 ? '' : 'es') + ', loss ' + loss.toFixed(3) + ').' + skipNote);
            draw();
            renderToolsPanel();
        } finally {
            nnTraining = false;
            nnRunMode = null;
            nnStopRequested = false;
            nnAbort = null;
            renderToolsPanel();
        }
    }

    // Predict classes for the not-manually-classified points of the current
    // z plane only: never-classified points plus previously predicted ones
    // (so iterations re-predict with the improved model). Manually
    // classified points are never overwritten.
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
        var pts = currentZPoints(layer, ref.z).filter(function (p) { return !p.c || p.pred; });
        if (pts.length === 0) {
            showHint('No points to predict on z=' + ref.z + '.');
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
            pts[i].pred = true;
            predicted++;
        }
        draw();
        renderToolsPanel();
        showHint('Predicted ' + predicted + ' point' + (predicted === 1 ? '' : 's') + ' on z=' + ref.z + '.');
    }

    // Revert the predicted (not manually classified) points of the current
    // z plane back to unclassified, e.g. to start over with a fresh model.
    function resetPredicted() {
        var layer = activePointsLayer();
        if (!layer) return;
        var ref = referenceImageLayer();
        var viewZ = ref ? ref.z : null;
        var reset = 0;
        for (var i = 0; i < layer.coords.length; i++) {
            var p = layer.coords[i];
            if (p.pred && pointEligible(p, viewZ)) {
                p.c = null;
                p.pred = false;
                reset++;
            }
        }
        if (reset === 0) return;
        draw();
        renderToolsPanel();
        var zLabel = viewZ === null ? '' : ' on z=' + viewZ;
        showHint('Reset ' + reset + ' predicted point' + (reset === 1 ? '' : 's') + zLabel + '.');
    }

    // Predict across every z plane that has predictable points (instead of
    // the current plane only). Each plane's slice is loaded on demand;
    // progress is shown per plane and the pass can be stopped mid-way
    // (already predicted points keep their classes). 2-column points (z
    // null) are "on every plane" and stay with the regular Predict — a
    // per-plane pass would re-assign them once per z.
    async function predictAllZ() {
        if (nnTraining) return;
        var layer = activePointsLayer();
        if (!layer || !layer.nn) {
            errorHint('Train the classifier first.');
            return;
        }
        var ref = referenceImageLayer();
        if (!ref) {
            errorHint('Load an image layer first — prediction needs its slices.');
            return;
        }
        var byZ = {};
        var count = 0;
        for (var i = 0; i < layer.coords.length; i++) {
            var p = layer.coords[i];
            if (p.z === null || (p.c && !p.pred)) continue;  // z-null + manual stay out
            var pz = Math.round(p.z);  // continuous CSV z -> nearest image plane
            if (pz < 0 || pz >= ref.zCount) continue;
            if (!byZ[pz]) byZ[pz] = [];
            byZ[pz].push(p);
            count++;
        }
        if (count === 0) {
            showHint('No points to predict across the stack.');
            return;
        }
        var zs = [];
        for (var key in byZ) zs.push(Number(key));
        zs.sort(function (a, b) { return a - b; });
        nnTraining = true;
        nnRunMode = 'predict-all';
        nnStopRequested = false;
        nnAbort = new AbortController();
        renderToolsPanel();
        var predicted = 0;
        var skipped = 0;
        var donePlanes = 0;
        var stopped = false;
        try {
            for (var zi = 0; zi < zs.length; zi++) {
                var z = zs[zi];
                var slice = ref.slices ? ref.slices.get(z) : null;
                if (!slice) {
                    try {
                        slice = await readSliceRaw(ref, z, nnAbort.signal);
                        initSliceRange(ref, slice);
                    } catch (err) {
                        if ((err && err.name === 'AbortError') || (nnAbort && nnAbort.signal.aborted)) {
                            stopped = true;  // Stop clicked mid-fetch
                            break;
                        }
                        skipped += byZ[z].length;  // slice failed to load
                        continue;
                    }
                }
                var pts = byZ[z];
                for (var t = 0; t < pts.length; t++) {
                    var fw = nnForward(layer.nn.net, pointFeatures(slice, pts[t], ref.dataRange));
                    var best = 0;
                    for (var k = 1; k < fw.probs.length; k++) {
                        if (fw.probs[k] > fw.probs[best]) best = k;
                    }
                    var c = layer.nn.classes[best];
                    if (layer.classCount && c > layer.classCount) c = layer.classCount;
                    pts[t].c = c;
                    pts[t].pred = true;
                    predicted++;
                }
                donePlanes = zi + 1;
                // progress after each plane (hint + status line + repaint)
                showHint('Predicting… ' + donePlanes + '/' + zs.length + ' planes · ' + predicted + ' points');
                el.nnStatus.textContent = 'Predicting… ' + donePlanes + '/' + zs.length + ' planes';
                draw();
                if (nnStopRequested) {
                    stopped = true;
                    break;
                }
            }
        } finally {
            nnTraining = false;
            nnRunMode = null;
            nnStopRequested = false;
            nnAbort = null;
            renderToolsPanel();
        }
        if (!layerById(layer.id)) return;  // layer was deleted mid-pass
        if (stopped || donePlanes < zs.length) {
            draw();  // repaint so already-predicted cells are visible after Stop
            showHint('Stopped — predicted ' + predicted + ' point' + (predicted === 1 ? '' : 's') +
                     ' across ' + donePlanes + '/' + zs.length + ' planes.');
            return;
        }
        var note = skipped > 0 ? ' Skipped ' + skipped + ' point' + (skipped === 1 ? '' : 's') + '.' : '';
        showHint('Predicted ' + predicted + ' point' + (predicted === 1 ? '' : 's') + ' across ' +
                 nnZLabel(zs) + '.' + note);
        draw();
        renderToolsPanel();
    }

    // Stop click during a predict-all pass: abort the in-flight slice fetch
    // and break at the next plane boundary (predicted points keep classes).
    function stopPredictAll() {
        if (nnRunMode !== 'predict-all') return;
        nnStopRequested = true;
        if (nnAbort) nnAbort.abort();
    }

    // Apply-to-all doubles as the Stop control while a prediction pass runs.
    function setApplyButton(running) {
        if (!el.nnApplyIcon || !el.nnApplyText) return;
        el.nnApplyIcon.className = 'bi ' + (running ? 'bi-stop-circle' : 'bi-stack') + ' me-1';
        el.nnApplyText.textContent = running ? 'Stop' : 'Apply to all';
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
            var key = sliceKey(img.z, sliceWindowFor(img));
            if (img.slices.has(key)) {
                if (zDebounceTimer) { clearTimeout(zDebounceTimer); zDebounceTimer = null; }
                draw();
                return;
            }
            if (zDebounceTimer) clearTimeout(zDebounceTimer);
            zDebounceTimer = setTimeout(function () {
                zDebounceTimer = null;
                if (!layerById(img.id)) return;  // layer was deleted mid-drag
                ensureSlice(img, img.z, sliceWindowFor(img));
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
        // full image dims (not the dims of whatever slice is cached — a
        // windowed entry covers only part of the plane)
        var w = img.fullWidth;
        var h = img.fullHeight;
        if (!w || !h) {
            ensureSlice(img, img.z);
            return;
        }
        var scale = Math.min(canvasW / w, canvasH / h);
        if (!isFinite(scale) || scale <= 0) scale = 1;
        view.scale = scale;
        view.tx = (canvasW - w * scale) / 2;
        view.ty = (canvasH - h * scale) / 2;
        view.fitted = true;
        draw();
    }

    // The image window the current view shows, quantized to the tile grid so
    // pans/zooms reuse one cache entry: [x0, y0, x1, y1] in image pixels, or
    // null when a full-plane read is wanted. A full-plane read is used when
    // the whole plane is on-screen (at or below its fit-scale — every pixel
    // is visible), when the dimensions are unknown, or when nothing is
    // visible. Single-strip layers always read full planes: one strip is the
    // atomic unit, so a "window" cannot fetch less than the whole image.
    function sliceWindowFor(layer) {
        var w = layer.fullWidth || 0;
        var h = layer.fullHeight || 0;
        if (!w || !h) return null;
        if (layer.singleStrip) return null;
        // the whole plane is on-screen when the view is at or below its
        // fit-scale (every pixel visible -> fetch all of it)
        if (view.scale <= Math.min(canvasW / w, canvasH / h)) return null;
        var x0 = clamp(-view.tx / view.scale, 0, w);
        var y0 = clamp(-view.ty / view.scale, 0, h);
        var x1 = clamp((canvasW - view.tx) / view.scale, 0, w);
        var y1 = clamp((canvasH - view.ty) / view.scale, 0, h);
        if (x1 <= x0 || y1 <= y0) return null;
        return [
            Math.max(0, Math.floor(x0 / TILE_GRID) * TILE_GRID),
            Math.max(0, Math.floor(y0 / TILE_GRID) * TILE_GRID),
            Math.min(w, Math.ceil(x1 / TILE_GRID) * TILE_GRID),
            Math.min(h, Math.ceil(y1 / TILE_GRID) * TILE_GRID)
        ];
    }

    function drawImageLayer(layer) {
        // Skip layers whose data source has not resolved yet: drawing them
        // would call ensureSlice()/readSliceRaw() before layer.tiff/urls
        // exist and mark the slice as failed before the real load lands.
        if (!layer.ready) return;
        var z = layer.z;
        var win = sliceWindowFor(layer);   // null = full-plane read
        var key = sliceKey(z, win);
        var entry = layer.paint.get(key);
        if (!entry || entry.cmin !== layer.contrast.min || entry.cmax !== layer.contrast.max) {
            if (layer.slices.has(key)) {
                paintSlice(layer, key);
                entry = layer.paint.get(key);
            } else {
                if (win) abortStaleWindowFetches(layer, z, key);
                ensureSlice(layer, z, win);
                return;
            }
        }
        if (!entry) return;
        ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.tx, dpr * view.ty);
        ctx.imageSmoothingEnabled = view.scale < 1;
        // windowed slices cover only [ox, ox + width) x [oy, oy + height) of
        // the image, so they are placed at their image offset (world coords
        // are image pixels)
        ctx.drawImage(entry.canvas, entry.ox, entry.oy);
    }

    function drawPointsLayer(layer, viewZ) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        for (var i = 0; i < layer.coords.length; i++) {
            var p = layer.coords[i];
            // napari convention: 3-column CSVs carry z (axis-0); points whose
            // snapped plane differs from the current plane are hidden.
            // 2-column points show on every plane.
            if (!pointEligible(p, viewZ)) continue;
            var sx = view.tx + p.x * view.scale;
            var sy = view.ty + p.y * view.scale;
            var margin = POINT_RADIUS + 3;  // ring extends past the point edge
            if (sx < -margin || sy < -margin ||
                sx > canvasW + margin || sy > canvasH + margin) continue;
            ctx.beginPath();
            ctx.arc(sx, sy, POINT_RADIUS, 0, Math.PI * 2);
            if (p.pred && p.c) {
                // predicted: hollow ring in the class color (manual points
                // are solid) so the two are distinguishable on the canvas
                ctx.strokeStyle = classColor(p.c);
                ctx.lineWidth = 2;
                ctx.stroke();
            } else {
                ctx.fillStyle = pointFillColor(p);
                ctx.fill();
                ctx.strokeStyle = POINT_EDGE;
                ctx.lineWidth = 1;
                ctx.stroke();
            }
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
            } else if (layer.type === 'labels') {
                drawLabelsLayer(layer);
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
        if (ref && !ref.paint.has(sliceKey(ref.z, sliceWindowFor(ref)))) {
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
            var labels = activeLabelsLayer();
            if (labels && !labels.sourceLoading && labelsPanelMode === 'draw' && labelsImage(labels)) {
                labelsStroke = { layer: labels, z: labelsImage(labels).z,
                                 erasing: labelsBrush === 'eraser', previous: null, work: Promise.resolve() };
                strokeLabels(labels, labelsStroke.z, e.clientX - rect.left, e.clientY - rect.top);
                return;
            }
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
            if (labelsStroke) {
                var canvasRect = el.canvas.getBoundingClientRect();
                strokeLabels(labelsStroke.layer, labelsStroke.z, e.clientX - canvasRect.left,
                             e.clientY - canvasRect.top);
                return;
            }
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
            if (labelsStroke) {
                labelsStroke = null;
                return;
            }
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
        } else if (data.fieldId === 'viewer-labels-path') {
            addLabelsFromSelection(data);
        } else if (data.fieldId === 'viewer-labels-export-path') {
            var exportLayer = layerById(pendingExportLayerId);
            pendingExportLayerId = null;
            if (exportLayer) exportLabels(exportLayer, data.selectedPath);
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
        el.nnReset = $('nnResetBtn');
        el.nnApply = $('nnApplyBtn');
        el.nnApplyIcon = $('nnApplyIcon');
        el.nnApplyText = $('nnApplyText');
        el.nnStatus = $('nnStatus');
        el.newLayerModal = $('viewerNewLayerModal');
        el.newLayerTitle = $('viewerNewLayerTitle');
        el.openLayer = $('viewerOpenLayerBtn');
        el.emptyLayer = $('viewerEmptyLayerBtn');
        el.labelsTools = $('labelsTools');
        el.labelsDrawBtn = $('labelsDrawBtn');
        el.labelsSegmentBtn = $('labelsSegmentBtn');
        el.labelsDrawPanel = $('labelsDrawPanel');
        el.labelsSegmentPanel = $('labelsSegmentPanel');
        el.labelsBrushBtn = $('labelsBrushBtn');
        el.labelsEraserBtn = $('labelsEraserBtn');
        el.labelsSize = $('labelsSize');
        el.labelsSizeValue = $('labelsSizeValue');
        el.labelsNumber = $('labelsNumber');
        el.labelsColor = $('labelsColor');
        el.labelsExportName = $('labelsExportName');
        el.labelsExport = $('labelsExportBtn');
        el.labelsTrain = $('labelsTrainBtn');
        el.labelsPredict = $('labelsPredictBtn');
        el.labelsStop = $('labelsStopBtn');
        el.labelsStatus = $('labelsStatus');
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
        attachLabelsEvents();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
