"""Home-page job/workflow history: pure helpers + rendered sections.

subprocess is mocked because squeue/sacct do not exist in the test env.
"""

import subprocess

import pytest

from conftest import fake_slurm_output


def test_best_status(peace_app):
    assert peace_app.best_status(["cancelled", "running"]) == "running"
    assert peace_app.best_status(["failed_to_dispatch", "pending"]) == "pending"
    assert peace_app.best_status([None, ""]) == "submitted"
    assert peace_app.best_status([]) == "submitted"
    assert peace_app.best_status([], fallback="paused") == "paused"


def test_collect_workflow_job_ids(peace_app):
    record = {"steps": [{"slurm_job_ids": ["1", "2"]}, {"slurm_job_ids": ["2", "3"]}, {}]}
    assert peace_app.collect_workflow_job_ids(record) == ["1", "2", "3"]


def test_enrich_job_record(peace_app):
    record = {"slurm_job_ids": ["123"], "status": "submitted"}
    enriched = peace_app.enrich_job_record(record, {"123": "running"})
    assert enriched["current_status"] == "running"
    assert "current_status" not in record, "the original record must not be mutated"
    # job ids missing from the state map fall back to the record status
    enriched = peace_app.enrich_job_record(
        {"slurm_job_ids": ["999"], "status": "submitted"}, {"123": "running"})
    assert enriched["current_status"] == "submitted"


def test_enrich_workflow_record(peace_app):
    record = {
        "status": "submitted",
        "steps": [
            {"slurm_job_ids": ["1"], "status": "submitted"},
            {"slurm_job_ids": ["2"], "status": "submitted"},
        ],
    }
    enriched = peace_app.enrich_workflow_record(
        record, {"1": "finished successfully", "2": "running"})
    assert enriched["steps"][0]["current_status"] == "finished successfully"
    assert enriched["current_status"] == "running", "running outranks finished"


def _make_job_record(peace_app, user="iana", job_ids=None):
    from utils.job_history import (create_job_payload_record,
                                   new_job_submission_payload, update_record)
    payload, _ = new_job_submission_payload("/tmp/in", "/tmp/out", "gaussian_blur",
                                            {"user": user}, user)
    record = create_job_payload_record(payload)
    if job_ids:
        update_record(record["history_file"], {"slurm_job_ids": job_ids})
        record["slurm_job_ids"] = job_ids
    return record


def test_home_renders_history_for_owner(client, login_session, peace_app, monkeypatch):
    from utils.job_history import (create_workflow_payload_record,
                                   new_workflow_submission_payload)
    monkeypatch.setattr(subprocess, "run", fake_slurm_output([]))
    job_record = _make_job_record(peace_app, "iana", ["4242"])
    wf_payload, _ = new_workflow_submission_payload(
        [{"input_bindings": {}, "output_name": "o1", "operation": "gaussian_blur",
          "extras": {}, "step_id": None}], "iana")
    wf_record = create_workflow_payload_record(wf_payload)

    login_session("iana")
    resp = client.get("/")
    assert resp.status_code == 200
    html = resp.get_data(as_text=True)
    assert "My jobs" in html and "My workflows" in html
    assert "gaussian_blur" in html
    assert job_record["job_record_id"] in html, "history action URLs must carry the record id"
    assert wf_record["workflow_id"] in html
    # the submitted job id appears in the Job IDs column
    assert "4242" in html


def test_home_empty_states_logged_in(client, login_session, monkeypatch):
    monkeypatch.setattr(subprocess, "run", fake_slurm_output([]))
    login_session("fresh-user")
    resp = client.get("/")
    html = resp.get_data(as_text=True)
    assert "No submitted jobs yet." in html
    assert "No submitted workflows yet." in html
