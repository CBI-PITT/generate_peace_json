"""Viewer page contracts: route, navbar tab, template wiring, and assets.

The Viewer page (templates/viewer.html + static/viewer/viewer.js +
static/styles/viewer.css) renders a kaibu-like layer panel + canvas viewer.
It reuses the shared browser modal chain (browser_modal.html +
browser_picker.js) and consumes the picker postMessage payloads keyed on the
'viewer-image-path' / 'viewer-points-path' field ids. Points layers export
their parsed coordinates through the kebab-menu Export entry as a canonical
napari-style CSV (per-class files plus an _unclassified file when classes
are in use) and get a tools panel below the layer list (add / select /
rectangle-select / classify / delete-selected points) with an in-browser
tiny-MLP classifier (Train / Predict on the current z plane).
"""

import pytest

from conftest import (  # noqa: F401  (fixtures)
    FLASK_APP,
    client,
    jinja_env,
    login_session,
    read_peace_template,
)

VIEWER_JS = FLASK_APP / "static" / "viewer" / "viewer.js"
GEOTIFF_JS = FLASK_APP / "static" / "viewer" / "vendor" / "geotiff.js"
VIEWER_CSS = FLASK_APP / "static" / "styles" / "viewer.css"


def test_viewer_assets_exist():
    assert VIEWER_JS.is_file(), "static/viewer/viewer.js missing"
    assert GEOTIFF_JS.is_file(), "vendored geotiff.js missing"
    assert VIEWER_CSS.is_file(), "static/styles/viewer.css missing"
    assert "fromArrayBuffer" in GEOTIFF_JS.read_text(), "geotiff.js bundle lacks fromArrayBuffer"


def test_viewer_template_wiring():
    tpl = read_peace_template("viewer.html")
    assert tpl.lstrip().startswith('{% extends "base.html" %}'), "viewer.html must extend base.html"
    assert '{% include "browser_modal.html" %}' in tpl, "browser modal not included"
    for needle in [
        'id="addLayerBtn"',
        'data-layer-type="image"',
        'data-layer-type="points"',
        'id="layerList"',
        'id="viewerCanvas"',
        'id="viewerCanvasWrap"',
        'id="viewerHint"',
        'id="zSlider"',
        'id="contrastDual"',
        'id="contrastFill"',
        'id="contrastMinSlider"',
        'id="contrastMaxSlider"',
        'id="viewer-image-path"',
        'id="viewer-points-path"',
        'viewer/vendor/geotiff.js',
        'js/browser_picker.js',
        'viewer/viewer.js',
        'styles/viewer.css',
    ]:
        assert needle in tpl, f"viewer.html missing {needle}"


def test_viewer_page_renders_offline(jinja_env):
    html = jinja_env.get_template("viewer.html").render()
    assert html.count("<script") == html.count("</script>"), "unbalanced <script> tags"
    assert html.count("bootstrap.bundle.min.js") == 1, "viewer page must keep exactly one bootstrap bundle"
    assert html.count("code.jquery.com") == 1, "viewer page must keep exactly one jQuery"
    assert html.count("viewer/viewer.js") == 1, "viewer.js loaded once"
    assert html.count("viewer/vendor/geotiff.js") == 1, "geotiff vendor loaded once"
    assert 'id="fileBrowserModal"' in html, "browser modal not rendered"
    assert 'id="fileBrowserFrame"' in html, "picker iframe missing"
    assert "data-field-id" in html, "iframe data-field-id missing"
    assert '<i class="bi bi-eye me-1"></i>Viewer' in html, "navbar Viewer tab missing"


def test_viewer_route_requires_login(client):
    resp = client.get("/viewer")
    assert resp.status_code == 302, "viewer must be login-gated like the operation pages"


def test_viewer_route_renders(client, login_session):
    login_session()
    resp = client.get("/viewer")
    assert resp.status_code == 200
    html = resp.get_data(as_text=True)
    assert html.count("<script") == html.count("</script>"), "unbalanced <script> tags"
    assert html.count("bootstrap.bundle.min.js") == 1, "viewer page must keep exactly one bootstrap bundle"
    assert 'id="viewerCanvas"' in html
    assert 'id="addLayerBtn"' in html
    assert '<i class="bi bi-eye me-1"></i>Viewer' in html, "navbar Viewer tab missing"
    assert 'href="/viewer"' in html, "navbar link must point at the viewer route"


def test_viewer_js_contracts():
    js = VIEWER_JS.read_text()
    for needle in [
        # picker glue: postMessage payloads keyed on the viewer field ids
        "'viewer-image-path'",
        "'viewer-points-path'",
        "addEventListener('message'",
        "openFileBrowser",
        # tiff decoding via the vendored geotiff.js
        "GeoTIFF.fromArrayBuffer",
        "readRasters",
        "getImageCount",
        # readRasters() shape normalization (geotiff 2.x returns an array of
        # sample planes; a failure must not re-trigger a fetch loop)
        "Array.isArray(rasters)",
        "layer.failed.add",
        # z slider: debounced load + aborted stale slice fetches + byte-budgeted
        # slice cache (a 40MB-per-slice stack must not queue one download per
        # position the drag passes)
        "AbortController",
        "abortStaleSliceFetches",
        "SLICE_CACHE_BYTES",
        # dual-handle contrast slider: one track, min + max handles, domain
        # 0..dtype-max for unsigned ints (data range for signed/float)
        "contrastDomain",
        "positionContrastFill",
        "raiseContrastHandle",
        # file serving + folder listing through the browser blueprint
        "'/browser/dir'",
        "'/browser/dir_json'",
        # napari-like CSV convention: axis-0/axis-1/axis-2 or z/y/x
        "['z', 'axis-0']",
        "['y', 'axis-1']",
        "['x', 'axis-2']",
        "parsePointsCsv",
        # zoom / pan
        "'wheel'",
        "'mousedown'",
        "'dblclick'",
        # layer list: visibility toggle + kebab menu with Delete
        "'bi-eye'",
        "'bi-eye-slash'",
        "bi-three-dots-vertical",
        "'Delete'",
        "dataset.bsToggle",
    ]:
        assert needle in js, f"viewer.js missing {needle}"


def test_viewer_export_contracts():
    js = VIEWER_JS.read_text()
    for needle in [
        # kebab menu: Export entry on points layers only (image layers stay
        # Delete-only)
        "layer.type === 'points'",
        "viewer-layer-export",
        "ex.dataset.action = 'export'",
        "bi-download",
        "'Export'",
        # export handler in the delegated layer-list click listener
        "actionEl.dataset.action === 'export'",
        "exportPointsCsv(layer)",
        # CSV writer + blob download
        "downloadBlob",
        "URL.createObjectURL",
        "revokeObjectURL",
        "new Blob(",
        "text/csv;charset=utf-8",
        # canonical napari headers that round-trip through parsePointsCsv:
        # axis-0/axis-1/axis-2 = z,y,x for 3-col layers, axis-0/axis-1 = y,x
        "hasZ ? 'axis-0,axis-1,axis-2' : 'axis-0,axis-1'",
        "pointsCsvName",
        "/\\.csv$/i",
        # multi-class export: one <name>_classN.csv per non-empty class plus
        # <name>_unclassified.csv for the unassigned points (a layer with no
        # non-empty class stays a plain <name>.csv)
        "classifyExportGroups",
        "classFileNameFor",
        "unclassifiedFileNameFor",
        "_unclassified.csv",
        "groups.unclassified",
        "pointsExportBase",
        "pointsCsvText",
    ]:
        assert needle in js, f"viewer.js missing {needle}"


def test_viewer_tools_contracts():
    tpl = read_peace_template("viewer.html")
    for needle in [
        # tools panel below the layer list
        'id="viewerTools"',
        'id="toolsNote"',
        'id="pointsTools"',
        'id="toolAddPoints"',
        'id="toolSelectPoints"',
        'id="toolClassifyPoints"',
        'id="toolDeleteSelected"',
        'id="selectSubPanel"',
        'id="additiveSelectToggle"',
        'id="classifySubPanel"',
        'id="classCountInput"',
        'id="classColorList"',
        'id="nnTrainBtn"',
        'id="nnPredictBtn"',
        'id="nnResetBtn"',
        'id="nnStatus"',
        'bi-tools',
        'bi-cursor',
        'bi-tags',
        'bi-cpu',
        'bi-magic',
        'bi-arrow-counterclockwise',
        'Additive selection',
        'viewer-tool-toggle',
    ]:
        assert needle in tpl, f"viewer.html missing {needle}"

    js = VIEWER_JS.read_text()
    for needle in [
        # one canvas interaction mode at a time; select suspends panning
        "var canvasMode = 'none'",
        "canvasMode === 'select'",
        "rectDrag",
        "additiveSelect",
        "setCanvasMode",
        "renderToolsPanel",
        "attachToolsEvents",
        # point actions: add, pick, rect select, classify, delete
        "addPointAtClick",
        "selectPointAtClick",
        "classifyPointAtClick",
        "finishRectSelect",
        "deleteSelectedPoints",
        "clearSelection",
        "activateClassification",
        "activePointsLayer",
        # pure helpers
        "pickPointIndex",
        "pointsInWorldRect",
        "pointEligible",
        "nextClass",
        "pointFillColor",
        # classification: points start unclassified; the first click assigns
        # class 1 and cycling wraps N -> 1
        "layer.classified = true",
        "p.c = nextClass(p.c, layer.classCount)",
        "CLASS_COLORS",
        "MAX_CLASSES",
        "UNCLASSIFIED_COLOR",
        # in-browser classifier: features = 10x10 intensity patch + coords,
        # tiny MLP (softmax + Adam), train/predict on the current z plane
        "trainClassifier",
        "predictUnclassified",
        "currentZPoints",
        "pointFeatures",
        "NN_PATCH",
        "nnCreate",
        "nnForward",
        "nnTrain",
        "adamUpdate",
        "layer.nn",
        "updateNnControls",
        # iterative loop: per-point provenance flag — training uses only
        # manually classified points, predict targets unclassified + previously
        # predicted points, clicking makes a point manual, Reset reverts
        "p.pred",
        "p.c && !p.pred",
        "!p.c || p.pred",
        "pred = true",
        "pred = false",
        "resetPredicted",
        # rendering: class colors + selected highlight ring + rect overlay
        "SELECT_RING",
        "setLineDash([4, 3])",
        "POINT_RADIUS + 2.5",
        "viewer-mode-select",
    ]:
        assert needle in js, f"viewer.js missing {needle}"

    css = VIEWER_CSS.read_text()
    for needle in [
        ".viewer-tools",
        ".viewer-tool-sub",
        ".viewer-class-swatch",
        ".viewer-class-row",
        ".viewer-class-pred-badge",
        ".viewer-nn-group",
        ".viewer-mode-select .viewer-canvas",
    ]:
        assert needle in css, f"viewer.css missing {needle}"


def test_viewer_css_contracts():
    css = VIEWER_CSS.read_text()
    for needle in [
        ".viewer-layout",
        ".viewer-panel",
        ".viewer-stage",
        ".viewer-canvas",
        ".viewer-hint",
        ".viewer-sliders",
        ".viewer-slider-row",
        ".viewer-layer-item",
        ".viewer-layer-eye",
    ]:
        assert needle in css, f"viewer.css missing {needle}"
