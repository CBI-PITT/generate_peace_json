"""Regression guards for the PEACE-side Browse button and shared picker.

The Browse chain: form button (.browse-btn + data-target) -> browser_picker.js
delegated handler -> #fileBrowserModal with the chrome-less iframe -> embed
page -> Select -> postMessage back to the parent. These tests pin each link.
"""

import pytest

from conftest import (
    BROWSER_TPL,
    PICKER_JS,
    FakeField,
    FakeForm,
    assert_browse_buttons_wired,
    browse_buttons,
    discover_form_templates,
    jinja_env,  # noqa: F401  (fixture)
    kitchen_sink_form,
    read_peace_template,
)


def test_browse_buttons_carry_browse_btn(jinja_env):
    """form.html and form_image_calculator.html must render every data-target
    button with the browse-btn class (the 2026-09-22 regression)."""
    form = FakeForm([
        FakeField("input", render_kw={"data-browse-only": "true"}),
        FakeField("input2", render_kw={"data-browse-only": "true"}),
        FakeField("notes"),
    ])
    html = jinja_env.get_template("form.html").render(form=form, operation="test")
    buttons = assert_browse_buttons_wired(html, "form.html")
    assert len(buttons) == 2, f"expected 2 browse buttons in form.html, found {len(buttons)}"

    calc_form = FakeForm([
        FakeField("input"), FakeField("calculator_operation", ftype="SelectField"),
        FakeField("input2"), FakeField("output"), FakeField("z_start"), FakeField("z_end"),
        FakeField("save_as_float", ftype="BooleanField"),
        FakeField("priority", ftype="RadioField", subfields=[FakeField("p1", label="1")]),
    ])
    html = jinja_env.get_template("form_image_calculator.html").render(
        form=calc_form, operation="image_calculator")
    buttons = assert_browse_buttons_wired(html, "form_image_calculator.html")
    assert len(buttons) == 3, f"expected 3 browse buttons in form_image_calculator.html, found {len(buttons)}"


def test_workflow_fragments_keep_browse_wiring(jinja_env):
    """The macro used by the workflow builder must stay wired too. Fragments
    are JSON-injected snippets — their modal + picker live in the parent page."""
    form = FakeForm([
        FakeField("input", render_kw={"data-browse-only": "true"}),
        FakeField("notes"),
    ])
    html = jinja_env.get_template("form_fragment.html").render(form=form)
    assert len(assert_browse_buttons_wired(html, "form_fragment.html", expect_modal=False)) == 1
    html = jinja_env.get_template("form_fragment_no_output.html").render(form=form)
    assert len(assert_browse_buttons_wired(html, "form_fragment_no_output.html", expect_modal=False)) == 1

    # the parent page that injects the fragments must load the modal + picker
    parent = read_peace_template("create_workflow.html")
    assert 'include "browser_modal.html"' in parent and "browser_picker.js" in parent


def test_all_operation_form_templates_wired(jinja_env):
    """Every template an operation's get_template() can return must keep the
    browse wiring. Uses AST discovery (no app import), so future operations on
    the standard templates are covered automatically."""
    templates = discover_form_templates()
    assert templates, "no operation form templates discovered"
    assert "form_autofill_output.html" in templates, "discovery missed the main form template"

    for name in templates:
        html = jinja_env.get_template(name).render(form=kitchen_sink_form(), operation="test")
        assert_browse_buttons_wired(html, name)


def test_form_scripts_chain_includes_modal_and_picker(jinja_env):
    """form.html's scripts block loads the modal + picker; the ~17 forms that
    extend form_autofill_output.html depend on its super() call."""
    html = jinja_env.get_template("form.html").render(form=kitchen_sink_form(), operation="test")
    assert "browser_picker.js" in html and 'id="fileBrowserModal"' in html

    html = jinja_env.get_template("form_autofill_output.html").render(
        form=kitchen_sink_form(), operation="test")
    assert "browser_picker.js" in html and 'id="fileBrowserModal"' in html
    assert "get_output_dir" in html, "output-autofill JS lost from form_autofill_output.html"


def test_picker_js_contracts():
    js = PICKER_JS.read_text()
    for contract in (
        'closest(".browse-btn")',            # delegated click handler
        'getAttribute("data-target")',       # field wiring
        'getElementById("fileBrowserFrame")',
        "dataset.fieldId",                   # iframe -> embed getFieldId contract
        'addEventListener("message"',        # select -> parent flow
        "selectedPath",
        "fileName",
        "nextBrowserPath",
        "lastBrowserPath =",                 # remembers the picker folder
        "selected-name-",
        'dispatchEvent(new Event("input"',   # keeps output autofill working
        "getOrCreateInstance",               # Bootstrap 5 modal API
        ".show()",
        ".hide()",
    ):
        assert contract in js, f"browser_picker.js lost contract: {contract}"
    assert ".modal(" not in js, "picker JS must not use the removed Bootstrap 4 jQuery modal API"


def test_modal_markup_bs5(jinja_env):
    html = jinja_env.get_template("browser_modal.html").render()
    assert 'id="fileBrowserModal"' in html
    assert 'id="fileBrowserFrame"' in html
    assert "data-field-id" in html
    assert "data-bs-dismiss" in html
    assert "data-dismiss=" not in html, "Bootstrap 4 data-dismiss crept back in"
    assert html.count("<script") == html.count("</script>")


def test_base_shell_single_bootstrap(jinja_env):
    html = jinja_env.get_template("base.html").render()
    found = [a for a in __import__("re").findall(r'(?:href|src)="([^"]+)"', html)
             if a.endswith((".css", ".js"))]
    assert len([a for a in found if a.startswith("https://code.jquery.com/jquery")]) == 1
    assert len([a for a in found if "bootstrap.bundle.min.js" in a]) == 1, (
        "base.html must load exactly one Bootstrap 5 bundle"
    )
    for legacy in ("bootstrap@4", "popper", "font-awesome", "fontawesome", "base.css"):
        assert not any(legacy.lower() in a.lower() for a in found), (
            f"legacy asset {legacy} must not be loaded by base.html"
        )
    assert html.count("<script") == html.count("</script>")


def test_cross_artifact_glue():
    """Both sides of every cross-file contract, so a rename on either side
    fails loudly instead of silently breaking the picker."""
    picker = PICKER_JS.read_text()
    embed_scripts = (BROWSER_TPL / "flask_file_browser" / "fl_browse_table_scripts.html").read_text()
    fs_browse = (BROWSER_TPL.parent / "fs_browse.py").read_text()
    form_html = read_peace_template("form.html")
    workflow_html = read_peace_template("create_workflow.html")
    browser_modal = read_peace_template("browser_modal.html")

    # postMessage payload: embed posts, picker consumes
    for key in ("fieldId", "selectedPath", "fileName", "nextBrowserPath"):
        assert key in embed_scripts, f"embed page no longer posts {key}"
        assert key in picker, f"picker no longer consumes {key}"

    # iframe field id: picker sets it, modal carries the attribute, embed reads it
    assert "dataset.fieldId" in picker
    assert "data-field-id" in browser_modal
    assert "window.frameElement" in embed_scripts

    # browse button class + attribute
    assert 'closest(".browse-btn")' in picker
    assert "browse-btn" in form_html
    assert 'getAttribute("data-target")' in picker
    assert "data-target=" in form_html

    # picker default URL matches the embed route registered in fs_browse.py
    assert '"/browser/dir_embed/"' in picker, "picker default path changed"
    assert "base_embed = '/dir_embed/'" in fs_browse, "embed route renamed; update browser_picker.js"

    # selected-name label prefix shared by picker, forms and workflow builder
    assert "selected-name-" in picker
    assert "selected-name-" in form_html
    assert "selected-name-" in workflow_html
