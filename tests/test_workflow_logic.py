"""Workflow validation, step normalization, submission, and templates."""

import json

import pytest


def test_validate_preprocessing_z_ranges_ok(peace_app):
    steps = [{"operation": "gaussian_blur", "extras": {"z_start": 0, "z_end": 5}}]
    peace_app.validate_preprocessing_z_ranges(steps)  # no raise
    # no z fields at all is fine
    peace_app.validate_preprocessing_z_ranges([{"operation": "gaussian_blur", "extras": {}}])
    # non-preprocessing operations are ignored
    peace_app.validate_preprocessing_z_ranges([{"operation": "dbscan", "extras": {"z_start": 1}}])
    # unknown operations are ignored
    peace_app.validate_preprocessing_z_ranges([{"operation": "nope", "extras": {"z_start": 1}}])
    # z_end = -1 means "to the end"
    peace_app.validate_preprocessing_z_ranges(
        [{"operation": "gaussian_blur", "extras": {"z_start": 0, "z_end": -1}}])


@pytest.mark.parametrize("extras", [
    {"z_start": 0},               # missing z_end
    {"z_end": 5},                 # missing z_start
    {"z_start": -1, "z_end": 5},  # negative start
    {"z_start": 0, "z_end": -2},  # end below -1
    {"z_start": 5, "z_end": 5},   # end <= start
    {"z_start": "0", "z_end": 5},  # non-integer start
])
def test_validate_preprocessing_z_ranges_invalid(peace_app, extras):
    with pytest.raises(ValueError):
        peace_app.validate_preprocessing_z_ranges(
            [{"operation": "gaussian_blur", "extras": extras}])


def test_validate_preprocessing_z_ranges_shape(peace_app):
    with pytest.raises(ValueError):
        peace_app.validate_preprocessing_z_ranges(["not-a-dict"])
    with pytest.raises(ValueError):
        peace_app.validate_preprocessing_z_ranges([{"operation": 42, "extras": {}}])
    with pytest.raises(ValueError):
        peace_app.validate_preprocessing_z_ranges([{"operation": "gaussian_blur"}])


def test_get_input_base_output_dir(peace_app, tmp_path):
    import os
    d = tmp_path / "exp"
    d.mkdir()
    (d / ".dataset_info.json").write_text(json.dumps({"base_output_dir": "/tmp/derived"}))
    assert peace_app.get_input_base_output_dir(str(d)) == "/tmp/derived"
    with pytest.raises(Exception):
        peace_app.get_input_base_output_dir(os.path.join(str(tmp_path), "missing"))


def test_get_output_dir_route(client, tmp_path):
    d = tmp_path / "exp"
    d.mkdir()
    (d / ".dataset_info.json").write_text(json.dumps({"base_output_dir": "/tmp/derived"}))
    resp = client.post("/get_output_dir", json={"input": str(d)})
    assert resp.status_code == 200
    assert resp.get_json()["output"] == "/tmp/derived"
    resp = client.post("/get_output_dir", json={"input": str(tmp_path / "missing")})
    assert resp.status_code == 400
    assert resp.get_json()["output"] == ""


def test_udpdate_steps_output_backfill_and_user(peace_app, login_request, tmp_path):
    from workflows import BaseWorkflow
    d = tmp_path / "exp"
    d.mkdir()
    (d / ".dataset_info.json").write_text(json.dumps({"base_output_dir": "/tmp/derived"}))
    wf = BaseWorkflow()
    wf.add_step(input={"input": str(d)}, output="", operation="gaussian_blur",
                extras={"input": str(d)})
    with login_request("dutta-p"):
        updated = peace_app.udpdate_steps(wf)
    step = updated.steps[0]
    assert step["extras"]["output"] == "/tmp/derived", "missing output must backfill from provenance"
    assert step["extras"]["user"] == "dutta-p", "the logged-in user must be stamped into extras"


def test_udpdate_steps_orientation(peace_app, login_request):
    from workflows import BaseWorkflow
    wf = BaseWorkflow()
    wf.add_step(input={}, output="out", operation="brainreg", extras={
        "orientation-select1": "ASR",
        "orientation-select2": "PSL",
        "orientation-select3": "RPI",
    })
    with login_request("CBI_Admin"):
        updated = peace_app.udpdate_steps(wf)
    extras = updated.steps[0]["extras"]
    assert extras["orientation"] == "APR", "the three selects must combine into one orientation"
    assert "orientation-select1" not in extras and "orientation-select2" not in extras
    assert extras["user"] == "CBI_Admin"


def test_udpdate_steps_metadata(peace_app, login_request):
    from workflows import BaseWorkflow
    wf = BaseWorkflow()
    wf.add_step(input={}, output="out", operation="combine_with_metadata", extras={
        "metadata-1-key": "b", "metadata-1-value": "2",
        "metadata-0-key": "a", "metadata-0-value": "1",
    })
    with login_request("iana"):
        updated = peace_app.udpdate_steps(wf)
    extras = updated.steps[0]["extras"]
    assert extras["metadata"] == [{"key": "a", "value": "1"}, {"key": "b", "value": "2"}]
    assert "metadata-0-key" not in extras and "metadata-1-value" not in extras


def test_workflow_new_route_validation_and_save(client, login_session, peace_app):
    login_session()
    # steps list required
    resp = client.post("/workflow/new", json={})
    assert resp.status_code == 400

    # invalid z range
    resp = client.post("/workflow/new", json={"steps": [
        {"input": {}, "output": "o", "operation": "gaussian_blur",
         "extras": {"z_start": 3, "z_end": 1}}]})
    assert resp.status_code == 400
    assert "z_end" in resp.get_json()["error"]

    # happy path
    resp = client.post("/workflow/new", json={"steps": [
        {"input": {}, "output": "out", "operation": "gaussian_blur", "extras": {}}]})
    assert resp.status_code == 200
    assert resp.get_json()["status"] == "ok"

    # the submission JSON lands in the sandboxed JSON folder
    import glob
    import os

    from config import JSON_FOLDER
    files = glob.glob(os.path.join(JSON_FOLDER, "SLURM_workflow_*.json"))
    assert files, "workflow submission JSON must be written to PEACE_JSON_FOLDER"
    with open(files[-1]) as f:
        payload = json.load(f)
    assert payload["steps"][0]["operation"] == "gaussian_blur"
    assert payload["steps"][0]["extras"]["user"] == "iana"


def test_workflow_operation_form_fragments(client, login_session):
    login_session()
    # reader operation -> form_fragment.html keeps the Output Location field
    resp = client.post("/workflow/operation_form", data={"operation": "imaris_reader"})
    assert resp.status_code == 200
    assert "Output Location" in resp.get_json()["form_html"]

    # non-reader operation -> form_fragment_no_output.html drops it
    resp = client.post("/workflow/operation_form", data={"operation": "gaussian_blur"})
    assert resp.status_code == 200
    assert "Output Location" not in resp.get_json()["form_html"]


def test_workflow_template_roundtrip(client, login_session, peace_app, monkeypatch, tmp_path):
    monkeypatch.setattr(peace_app, "WORKFLOW_TEMPLATE_FOLDER", str(tmp_path))
    login_session()
    workflow = {"steps": [{"input": {}, "output": "out", "operation": "gaussian_blur",
                           "extras": {}}]}

    resp = client.post("/workflow/templates/save", json={"name": "my template", "workflow": workflow})
    assert resp.status_code == 200
    assert resp.get_json()["template"]["slug"] == "my_template"

    resp = client.get("/workflow/templates")
    assert any(t["slug"] == "my_template" for t in resp.get_json()["templates"])

    resp = client.get("/workflow/templates/my_template")
    assert resp.status_code == 200
    assert resp.get_json()["name"] == "my template"

    # templates must include a steps list
    resp = client.post("/workflow/templates/save", json={"name": "x", "workflow": {"steps": "nope"}})
    assert resp.status_code == 400

    # template names are required
    resp = client.post("/workflow/templates/save", json={"name": "  ", "workflow": workflow})
    assert resp.status_code == 400

    # z-range validation applies to templates too
    resp = client.post("/workflow/templates/save", json={"name": "bad", "workflow": {
        "steps": [{"input": {}, "output": "o", "operation": "gaussian_blur",
                   "extras": {"z_start": 3, "z_end": 1}}]}})
    assert resp.status_code == 400

    # delete round-trip
    resp = client.post("/workflow/templates/my_template/delete")
    assert resp.status_code == 200
    assert client.get("/workflow/templates/my_template").status_code == 404
    assert client.post("/workflow/templates/my_template/delete").status_code == 404
