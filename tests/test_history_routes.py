"""Job/workflow history: control-command normalization, permissions, routes.

subprocess is mocked because squeue/sacct/scancel do not exist in the test env.
"""

import subprocess

import pytest

from conftest import fake_slurm_output


def test_run_control_command_normalizes_ids(peace_app, monkeypatch):
    calls = []

    def fake_run(command, *args, **kwargs):
        calls.append(list(command))
        return type("R", (), {"stdout": "", "stderr": "", "returncode": 0})()

    monkeypatch.setattr(subprocess, "run", fake_run)
    ids = peace_app.run_control_command(["scancel"], ["123", "456_[1-9%4]", "789.0", ""])
    assert ids == ["123", "456", "789"], "compressed array-job ids must normalize to their base id"
    assert calls == [["scancel", "123", "456", "789"]]


def test_run_control_command_without_jobs(peace_app, monkeypatch):
    def fail(*args, **kwargs):
        raise AssertionError("subprocess must not run without job ids")
    monkeypatch.setattr(subprocess, "run", fail)
    with pytest.raises(ValueError):
        peace_app.run_control_command(["scancel"], [])


def test_run_control_command_raises_on_failure(peace_app, monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: type(
        "R", (), {"stdout": "", "stderr": "boom", "returncode": 1})())
    with pytest.raises(RuntimeError, match="boom"):
        peace_app.run_control_command(["scancel"], ["123"])


def test_can_manage_record(peace_app, login_request):
    with login_request("iana"):
        assert peace_app.can_manage_record({"submitted_by": "iana"})
        assert not peace_app.can_manage_record({"submitted_by": "someone-else"})
        assert not peace_app.can_manage_record(None)
    with login_request("CBI_Admin"):
        assert peace_app.can_manage_record({"submitted_by": "someone-else"})
    with peace_app.app.test_request_context():
        assert not peace_app.can_manage_record({"submitted_by": "iana"}), (
            "anonymous users cannot manage records"
        )


def _make_job_record(peace_app, user="iana", job_ids=("123",)):
    from utils.job_history import (create_job_payload_record,
                                   new_job_submission_payload, update_record)
    payload, _ = new_job_submission_payload("/tmp/in", "/tmp/out", "gaussian_blur",
                                            {"user": user}, user)
    record = create_job_payload_record(payload)
    update_record(record["history_file"], {"slurm_job_ids": list(job_ids)})
    record["slurm_job_ids"] = list(job_ids)
    return record


def _make_workflow_record(peace_app, user="iana", job_ids=("111", "222")):
    from utils.job_history import (create_workflow_payload_record,
                                   new_workflow_submission_payload, update_record)
    steps = [
        {"input_bindings": {}, "output_name": "step1_out", "operation": "gaussian_blur",
         "extras": {}, "step_id": None},
        {"input_bindings": {"input": "step1_out"}, "output_name": "step2_out",
         "operation": "dbscan", "extras": {}, "step_id": None},
    ]
    payload, _ = new_workflow_submission_payload(steps, user)
    record = create_workflow_payload_record(payload)
    record["steps"] = [{**s, "slurm_job_ids": [jid]}
                       for s, jid in zip(record["steps"], job_ids)]
    update_record(record["history_file"], {"steps": record["steps"]})
    return record


def test_cancel_history_job_route(client, login_session, peace_app, monkeypatch):
    from utils.job_history import load_job_record
    fake = fake_slurm_output([])
    monkeypatch.setattr(subprocess, "run", fake)
    record = _make_job_record(peace_app, "iana", ["123"])
    login_session("iana")
    resp = client.post(f"/history/job/{record['job_record_id']}/cancel")
    assert resp.status_code == 200
    assert resp.get_json()["message"] == "Job cancelled"
    assert ["scancel", "123"] in fake.calls
    assert load_job_record("iana", record["job_record_id"])["status"] == "cancelled"


def test_history_job_permission_rules(client, login_session, peace_app, monkeypatch):
    fake = fake_slurm_output([])
    monkeypatch.setattr(subprocess, "run", fake)
    record = _make_job_record(peace_app, "iana", ["123"])

    login_session("other-user")
    resp = client.post(f"/history/job/{record['job_record_id']}/cancel")
    assert resp.status_code == 403, "non-owners must not manage records"

    # history records are stored per user, so a CBI_Admin record is managed
    # from its own folder
    admin_record = _make_job_record(peace_app, "CBI_Admin", ["555"])
    login_session("CBI_Admin")
    resp = client.post(f"/history/job/{admin_record['job_record_id']}/hold")
    assert resp.status_code == 200, "CBI_Admin can manage their own records"


def test_history_job_hold_release_rerun(client, login_session, peace_app, monkeypatch):
    from utils.job_history import load_job_record
    monkeypatch.setattr(subprocess, "run", fake_slurm_output([]))
    record = _make_job_record(peace_app, "iana", ["123"])
    login_session("iana")

    resp = client.post(f"/history/job/{record['job_record_id']}/hold")
    assert resp.get_json()["message"] == "Job held"
    assert load_job_record("iana", record["job_record_id"])["status"] == "paused"

    resp = client.post(f"/history/job/{record['job_record_id']}/release")
    assert resp.get_json()["message"] == "Job released"
    assert load_job_record("iana", record["job_record_id"])["status"] == "submitted"

    resp = client.post(f"/history/job/{record['job_record_id']}/rerun")
    assert resp.status_code == 200
    new_id = resp.get_json()["job_record_id"]
    new_record = load_job_record("iana", new_id)
    assert new_record["rerun_of"] == record["job_record_id"]
    assert new_record["operation"] == "gaussian_blur"


def test_cancel_history_workflow_route(client, login_session, peace_app, monkeypatch):
    from utils.job_history import load_workflow_record
    fake = fake_slurm_output([])
    monkeypatch.setattr(subprocess, "run", fake)
    record = _make_workflow_record(peace_app)
    login_session("iana")
    resp = client.post(f"/history/workflow/{record['workflow_id']}/cancel")
    assert resp.status_code == 200
    scancel_call = [c for c in fake.calls if c[0] == "scancel"][0]
    assert "111" in scancel_call and "222" in scancel_call, (
        "workflow cancel must target every step's job ids"
    )
    reloaded = load_workflow_record("iana", record["workflow_id"])
    assert reloaded["status"] == "cancelled"
    assert all(step["status"] == "cancelled" for step in reloaded["steps"])


def test_resolve_forked_workflow_steps(peace_app):
    record = {
        "submission_payload": {"steps": [
            {"step_id": "s1", "extras": {"input": "/orig1"}, "input_bindings": {},
             "output_name": "o1"},
            {"step_id": "s2", "extras": {}, "input_bindings": {"input": "o1"},
             "output_name": "o2"},
            {"step_id": "s3", "extras": {}, "input_bindings": {"input": "o1"},
             "output_name": "o3"},
        ]},
        "steps": [
            {"step_id": "s1", "resolved_input": "/resolved1", "resolved_extras": {"channel": 0}},
            {"step_id": "s2", "resolved_extras": {"eps": 1.5}},
            {"step_id": "s3", "resolved_extras": None, "resolved_input": None},
        ],
    }
    steps = peace_app.resolve_forked_workflow_steps(record, "s2")
    assert len(steps) == 2, "the fork starts at the requested step"
    # the fork's first step takes the fully resolved extras
    assert steps[0]["extras"] == {"eps": 1.5}
    assert steps[0]["step_id"] is None
    assert steps[0]["input_bindings"] == {}
    # s3's binding to o1 is stripped because the fork no longer produces o1
    assert steps[1]["input_bindings"] == {}


def test_workflow_fork_rerun_route(client, login_session, peace_app, monkeypatch):
    from utils.job_history import load_workflow_record, update_record
    monkeypatch.setattr(subprocess, "run", fake_slurm_output([]))
    record = _make_workflow_record(peace_app)
    update_record(record["history_file"], {"steps": [
        {**record["steps"][0], "resolved_extras": {"channel": 0},
         "resolved_input": "/tmp/reader_out"},
        record["steps"][1],
    ]})
    login_session("iana")
    step_id = record["steps"][0]["step_id"]
    resp = client.post(f"/history/workflow/{record['workflow_id']}/steps/{step_id}/rerun")
    assert resp.status_code == 200
    new_id = resp.get_json()["workflow_id"]
    new_record = load_workflow_record("iana", new_id)
    assert new_record["rerun_of"] == record["workflow_id"]
    assert len(new_record["steps"]) == 2, "the fork reruns from the chosen step onward"
    # the fork's first step takes its resolved extras from history
    assert new_record["steps"][0]["extras"] == {"channel": 0}
    # bindings to outputs the fork still produces are preserved
    assert new_record["steps"][1]["input_bindings"] == {"input": "step1_out"}


def test_workflow_hold_updates_all_steps(client, login_session, peace_app, monkeypatch):
    from utils.job_history import load_workflow_record
    monkeypatch.setattr(subprocess, "run", fake_slurm_output([]))
    record = _make_workflow_record(peace_app)
    login_session("iana")
    resp = client.post(f"/history/workflow/{record['workflow_id']}/hold")
    assert resp.status_code == 200
    reloaded = load_workflow_record("iana", record["workflow_id"])
    assert reloaded["status"] == "paused"
    assert all(step["status"] == "paused" for step in reloaded["steps"])
