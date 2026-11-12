"""Viewer page contracts: route, navbar tab, template wiring, and assets.

The Viewer page (templates/viewer.html + static/viewer/viewer.js +
static/styles/viewer.css) renders a kaibu-like layer panel + canvas viewer.
It reuses the shared browser modal chain (browser_modal.html +
browser_picker.js) and consumes the picker postMessage payloads keyed on the
'viewer-image-path' / 'viewer-points-path' field ids.
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
