"""Shared fixtures for the PEACE-side tests.

Two kinds of tests live here:
- render/static picker-contract tests (test_browse_picker.py), and
- app-logic tests that import the real Flask app (test_catalog_routes.py,
  test_home_history.py, test_workflow_logic.py, test_history_routes.py,
  test_queue_utils.py) using the Flask test client.

All write side effects are sandboxed: config.py reads PEACE_JSON_FOLDER at
import time, so the env is forced to a temp dir below before the app is
imported. The live server is a separate process and is never touched.
"""

import ast
import json
import os
import re
import sys
import tempfile
from pathlib import Path

import pytest
from jinja2 import Environment, FileSystemLoader

REPO_ROOT = Path(__file__).resolve().parents[1]
FLASK_APP = REPO_ROOT / "flask_app"
PEACE_TPL = FLASK_APP / "templates"
BROWSER_TPL = REPO_ROOT.parent / "flask_file_browser_test" / "flask_file_browser" / "templates"

PICKER_JS = Path(__file__).resolve().parents[1] / "flask_app" / "static" / "js" / "browser_picker.js"

# Sandboxed write locations — MUST be set before config/app are imported.
_SANDBOX_JSON = tempfile.mkdtemp(prefix='peace_test_json_')
os.environ['PEACE_JSON_FOLDER'] = _SANDBOX_JSON
os.environ['PEACE_JOB_HISTORY_DIR'] = os.path.join(_SANDBOX_JSON, 'history')


class _User:
    is_authenticated = True

    def get_id(self):
        return "iana"


def _url_for(endpoint, **kw):
    return f"/URL/{endpoint}" + (f"/{kw['filename']}" if kw.get("filename") else "")


@pytest.fixture(scope="session")
def jinja_env():
    env = Environment(loader=FileSystemLoader([str(PEACE_TPL), str(BROWSER_TPL)]))
    env.filters["tojson"] = lambda v: json.dumps(v)
    env.globals["url_for"] = _url_for
    env.globals["get_flashed_messages"] = lambda with_categories=False: []
    env.globals["current_user"] = _User()

    class _Req:
        endpoint = "operation_form"

    env.globals["request"] = _Req()
    return env


class FakeLabel:
    def __init__(self, text):
        self.text = text

    def __call__(self, **kw):
        return f"<label>{self.text}</label>"


class FakeField:
    def __init__(self, name, ftype="StringField", input_type="text", label=None,
                 render_kw=None, errors=None, data="", subfields=None):
        self.name = name
        self.type = ftype
        self.widget = type("Widget", (), {"input_type": input_type})()
        self.label = FakeLabel(label or name)
        self.render_kw = render_kw or {}
        self.errors = errors or []
        self.data = data
        self.id = name
        self.subfields = subfields or []

    def __call__(self, **kw):
        attrs = " ".join(f'{k}="{v}"' for k, v in kw.items())
        return f'<input name="{self.name}" {attrs}>'

    def __iter__(self):
        return iter(self.subfields)


class FakeForm:
    def __init__(self, fields, metadata=None):
        self._fields = fields
        self.metadata = metadata
        for field in fields:
            setattr(self, field.name, field)

    def __iter__(self):
        return iter(self._fields)

    def hidden_tag(self):
        return '<input type="hidden" name="csrf_token">'


def browse_buttons(html):
    """[(field_id, button_tag)] for every data-target button in the page."""
    return [(m.group(1), m.group(0))
            for m in re.finditer(r'<button[^>]*data-target="([^"]*)"[^>]*>', html)]


def assert_browse_buttons_wired(html, label, expect_modal=True):
    """Every data-target button must carry the .browse-btn class the shared
    picker delegates on. Full pages must also load the modal + picker; workflow
    fragments are JSON-injected snippets whose modal lives in the parent page
    (create_workflow.html), so pass expect_modal=False for those."""
    buttons = browse_buttons(html)
    for field_id, tag in buttons:
        assert "browse-btn" in tag, (
            f"{label}: the data-target button for '{field_id}' lost the browse-btn "
            f"class — browser_picker.js only matches closest('.browse-btn'), so the "
            f"click silently does nothing. Tag: {tag}"
        )
    if buttons and expect_modal:
        assert 'id="fileBrowserModal"' in html, f"{label}: browser modal not included"
        assert 'id="fileBrowserFrame"' in html, f"{label}: picker iframe missing"
        assert "data-field-id" in html, f"{label}: iframe data-field-id attribute missing"
        assert "browser_picker.js" in html, f"{label}: browser_picker.js not loaded"
    assert html.count("<script") == html.count("</script>"), f"{label}: unbalanced <script> tags"
    return buttons


def kitchen_sink_form():
    """A form with every field type/name the operation templates render."""
    pair = FakeForm([
        FakeField("metadata-0-key"),
        FakeField("metadata-0-value"),
    ])
    return FakeForm([
        FakeField("input", render_kw={"data-browse-only": "true"}),
        FakeField("input2", render_kw={"data-browse-only": "true"}),
        FakeField("output"),
        FakeField("notes"),
        FakeField("calculator_operation", ftype="SelectField"),
        FakeField("channel", ftype="SelectField"),
        FakeField("z_start"),
        FakeField("z_end"),
        FakeField("save_as_float", ftype="BooleanField"),
        FakeField("priority", ftype="RadioField", subfields=[
            FakeField("p1", label="1"), FakeField("p2", label="2")]),
        FakeField("orient", ftype="FormField", subfields=[
            FakeField("o1"), FakeField("o2")]),
    ], metadata=[pair])


def discover_form_templates():
    """Collect get_template() return strings from operation/plugin modules via
    AST (no app import) so every current and future operation form is covered."""
    names = set()
    for folder in ("operations", "plugins", "reader_plugins"):
        for py in sorted((FLASK_APP / folder).glob("*.py")):
            if py.name == "__init__.py":
                continue
            tree = ast.parse(py.read_text())
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "get_template":
                    for sub in ast.walk(node):
                        if (isinstance(sub, ast.Return) and isinstance(sub.value, ast.Constant)
                                and isinstance(sub.value.value, str)):
                            names.add(sub.value.value)
    return sorted(names)


def read_peace_template(name):
    return (PEACE_TPL / name).read_text()


# --------------------------------------------------------------------------
# App fixtures (test client + mocked login)
# --------------------------------------------------------------------------

class _FakeCompleted:
    """Stand-in for subprocess.CompletedProcess."""

    def __init__(self, stdout="", stderr="", returncode=0):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


@pytest.fixture(scope="session")
def peace_app():
    """Import the real Flask app (plugins, blueprint, auth) once, with all
    writes sandboxed to the temp PEACE_JSON_FOLDER."""
    if str(FLASK_APP) not in sys.path:
        sys.path.insert(0, str(FLASK_APP))
    import app as app_module
    return app_module


@pytest.fixture()
def client(peace_app):
    return peace_app.app.test_client()


@pytest.fixture()
def login_session(client):
    """Log the test client in without LDAP: load_user accepts any id."""
    def _login(user_id="iana"):
        with client.session_transaction() as sess:
            sess["_user_id"] = user_id
            sess["_fresh"] = True
    return _login


@pytest.fixture()
def login_request(peace_app):
    """Context manager that logs flask_login's current_user in inside a request
    context, for direct unit tests of app functions that read current_user."""
    from contextlib import contextmanager

    from flask_login import login_user

    @contextmanager
    def _login(user_id="iana"):
        from auth import User
        with peace_app.app.test_request_context():
            login_user(User(user_id))
            yield
    return _login


def fake_slurm_output(lines):
    """A subprocess.run stand-in for mocked squeue/sacct/scancel calls."""
    calls = []

    def _run(command, *args, **kwargs):
        calls.append(list(command))
        for expected, stdout in lines:
            if expected in command:
                return _FakeCompleted(stdout=stdout)
        return _FakeCompleted(stdout="")
    _run.calls = calls
    return _run

