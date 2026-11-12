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
    var POINT_COLOR = '#ffdd00';
    var POINT_EDGE = 'rgba(20, 20, 20, 0.85)';
    var POINT_RADIUS = 3.5;
    var VIEW_BG = '#1a1f29';
    var MIN_SCALE = 0.001;
    var MAX_SCALE = 200;

    var layers = [];
    var activeLayerId = null;
    var nextLayerId = 1;
    var hintKind = 'default';
    var lastAdded = null;

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
        layers.push(layer);
        activeLayerId = layer.id;
        view.fitted = false;  // refit to the new layer once its first slice loads
        renderLayerList();
        syncSliders();
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
                var coords = parsePointsCsv(text);
                if (coords.length === 0) throw new Error('no coordinate rows found');
                var layer = makeLayer('points', name);
                layer.coords = coords;
                layers.push(layer);
                activeLayerId = layer.id;
                renderLayerList();
                syncSliders();
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
    // Sliders
    // ------------------------------------------------------------------

    function fmtContrast(v, isFloat) {
        if (isFloat) return Number(v).toFixed(2);
        return String(Math.round(v));
    }

    function updateContrastSliders(img) {
        if (!img.dataRange || !img.contrast) return;
        var span = (img.dataRange.max - img.dataRange.min) || 1;
        var step = img.float ? span / 255 : 1;
        el.contrastMin.min = img.dataRange.min;
        el.contrastMin.max = img.dataRange.max;
        el.contrastMin.step = step;
        el.contrastMin.value = img.contrast.min;
        el.contrastMax.min = img.dataRange.min;
        el.contrastMax.max = img.dataRange.max;
        el.contrastMax.step = step;
        el.contrastMax.value = img.contrast.max;
        el.contrastMinValue.textContent = fmtContrast(img.contrast.min, img.float);
        el.contrastMaxValue.textContent = fmtContrast(img.contrast.max, img.float);
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
        if (img && img.dataRange) {
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
        ctx.lineWidth = 1;
        for (var i = 0; i < layer.coords.length; i++) {
            var p = layer.coords[i];
            // napari convention: 3-column CSVs carry z (axis-0); points whose z
            // differs from the current plane are hidden. 2-column points show
            // on every plane.
            if (p.z !== null && viewZ !== null && p.z !== viewZ) continue;
            var sx = view.tx + p.x * view.scale;
            var sy = view.ty + p.y * view.scale;
            if (sx < -POINT_RADIUS - 2 || sy < -POINT_RADIUS - 2 ||
                sx > canvasW + POINT_RADIUS + 2 || sy > canvasH + POINT_RADIUS + 2) continue;
            ctx.beginPath();
            ctx.arc(sx, sy, POINT_RADIUS, 0, Math.PI * 2);
            ctx.fillStyle = POINT_COLOR;
            ctx.fill();
            ctx.strokeStyle = POINT_EDGE;
            ctx.stroke();
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
        el.canvas.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            dragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
            el.canvas.classList.add('viewer-dragging');
        });
        window.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            view.tx += e.clientX - lastX;
            view.ty += e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;
            draw();
        });
        window.addEventListener('mouseup', function () {
            dragging = false;
            el.canvas.classList.remove('viewer-dragging');
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
        attachCanvasEvents();
        attachPanelEvents();
        attachSliderEvents();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
