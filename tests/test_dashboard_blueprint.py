"""Data dashboard blueprint integration on the PEACE side: registration,
config flag, navbar link gating, and cross-repo glue."""

import re

from conftest import read_peace_template


def test_dashboard_routes_registered_on_real_app(peace_app):
    """app.py registers the data_dashboard blueprint and the config flag is
    set from its settings.ini."""
    assert peace_app.app.config["DATA_DASHBOARD_ENABLED"] is True
    registered = {str(rule) for rule in peace_app.app.url_map.iter_rules()}
    for route in (
        "/dashboard/",
        "/dashboard/api/indices",
        "/dashboard/api/index_choosen/<path:identifier>",
        "/dashboard/api/index_choosen/meta/<path:identifier>",
        "/dashboard/api/index_choosen/current_status/<path:identifier>",
        "/dashboard/api/query",
        "/dashboard/api/query_paras",
        "/dashboard/api/add_csv",
        "/dashboard/api/whoami",
        "/dashboard/api/merge",
        "/dashboard/api/datasets/<path:identifier>/rename",
        "/dashboard/indexInfo",
    ):
        assert route in registered, "missing dashboard route: %s" % route


def test_app_py_registers_blueprint_after_browser():
    source = (peace_app_flask_dir() / "app.py").read_text()
    assert "from data_dashboard import routes as data_dashboard_routes" in source
    assert 'data_dashboard_routes.init_blueprint(app, prefix="/dashboard")' in source
    browser_at = source.find('routes.init_blueprint(app, prefix="/browser")')
    dashboard_at = source.find('data_dashboard_routes.init_blueprint(app, prefix="/dashboard")')
    assert -1 < browser_at < dashboard_at, "dashboard blueprint must register after the browser"


def peace_app_flask_dir():
    from pathlib import Path
    return Path(__file__).resolve().parents[1] / "flask_app"


def test_navbar_link_gated_by_config_flag(client, login_session):
    """The Dashboard link renders in the PEACE navbar when the blueprint is
    enabled."""
    login_session()
    html = client.get("/").get_data(as_text=True)
    match = re.search(r'<a class="nav-link[^"]*"[^>]*href="(/dashboard/?)"', html)
    assert match, "Dashboard navbar link missing"
    assert "bi-bar-chart-line" in html, "Dashboard navbar icon missing"


def test_navbar_link_absent_without_config_global(jinja_env):
    """Offline render (no Flask config global, like the picker-contract test
    env) must not crash and must not render the Dashboard link."""
    html = jinja_env.get_template("base.html").render()
    assert "/dashboard" not in html, "dashboard link leaked without the config flag"
    assert html.count("<script") == html.count("</script>")


def test_base_html_gate_uses_config_defined_short_circuit():
    """The gate must short-circuit on `config is defined` so offline Jinja
    renders without a config global still work."""
    base = read_peace_template("base.html")
    match = re.search(
        r"\{%\s*if config is defined and config\.get\('DATA_DASHBOARD_ENABLED'", base)
    assert match, "base.html must gate the dashboard link with `config is defined and config.get('DATA_DASHBOARD_ENABLED', ...)`"


def test_cross_repo_add_url_glue():
    """The browser's [dashboard] add_url must point at the endpoint the PEACE
    app actually registers."""
    import configparser
    from pathlib import Path
    browser_ini = Path(__file__).resolve().parents[2] / "flask_file_browser_test" / "flask_file_browser" / "settings.ini"
    settings = configparser.ConfigParser(allow_no_value=True)
    settings.read(str(browser_ini))
    assert settings.get("dashboard", "add_url", fallback="").strip() == "/dashboard/api/add_csv"
