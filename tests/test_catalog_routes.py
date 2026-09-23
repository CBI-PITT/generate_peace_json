"""Catalog routes: /operations, /categories, /analyze/<category>, /read, /."""

import pytest


def test_build_catalog_groups(peace_app):
    groups = peace_app.build_catalog()
    assert groups, "catalog must have groups"
    assert groups[0]["key"] == "readers", "readers must be the first group"
    keys = [g["key"] for g in groups]
    assert "pre_processing" in keys and "post_processing" in keys
    for group in groups:
        assert group["label"] and isinstance(group["label"], str)
        for op_name, description in group["operations"]:
            assert isinstance(op_name, str) and op_name
            assert isinstance(description, str)
    reader_ops = [name for name, _ in groups[0]["operations"]]
    assert set(reader_ops) == set(peace_app.READER_PLUGINS.keys()), (
        "the catalog must list every real reader plugin"
    )


def test_build_catalog_descriptions_match_plugins(peace_app):
    for group in peace_app.build_catalog():
        for op_name, description in group["operations"]:
            plugin = (peace_app.OPERATIONS.get(op_name) or peace_app.PLUGINS.get(op_name)
                      or peace_app.READER_PLUGINS.get(op_name))
            assert plugin is not None, f"{op_name} missing from the plugin registries"
            assert description == plugin.description


def test_operations_route_renders_catalog(client):
    resp = client.get("/operations")
    assert resp.status_code == 200
    html = resp.get_data(as_text=True)
    assert 'data-filter="all"' in html
    assert "catalog-search" in html
    assert 'data-category-group="readers"' in html
    assert 'href="/operation/' in html, "operations must link to their forms"


def test_categories_redirects_to_catalog(client):
    resp = client.get("/categories")
    assert resp.status_code == 302
    assert "/operations" in resp.headers["Location"]


def test_analyze_prefilters_catalog(client):
    resp = client.get("/analyze/pre_processing")
    assert resp.status_code == 200
    assert 'activeOnLoad = "pre_processing"' in resp.get_data(as_text=True)


def test_read_prefilters_catalog(client):
    resp = client.get("/read")
    assert resp.status_code == 200
    assert 'activeOnLoad = "readers"' in resp.get_data(as_text=True)


def test_home_renders_action_cards_and_hides_history_anonymous(client):
    resp = client.get("/")
    assert resp.status_code == 200
    html = resp.get_data(as_text=True)
    for text in ("Read Data", "Process Data", "Create a Workflow"):
        assert text in html
    assert "My jobs" not in html and "My workflows" not in html, (
        "history sections must stay hidden for anonymous visitors"
    )
