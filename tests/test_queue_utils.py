"""SLURM queue route, /cancel, output-dir lookup, and the slurm/user utils.

subprocess is mocked because squeue/scancel do not exist in the test env.
"""

import subprocess

import pytest

from conftest import fake_slurm_output

SQUEUE_STDOUT = (
    "JOBID PARTITION NAME USER ST TIME NODES(Q)\n"
    "123 cpu iana_experiment iana R 1:00 1\n"
    "124 gpu other_experiment other PD 0:00 1\n"
)


def test_queue_route_parses_rows(client, monkeypatch):
    monkeypatch.setattr(subprocess, "run", fake_slurm_output([("squeue", SQUEUE_STDOUT)]))
    resp = client.get("/queue")
    assert resp.status_code == 200
    html = resp.get_data(as_text=True)
    assert "iana_experiment" in html and "other_experiment" in html
    assert "123" in html and "124" in html
    assert "peace-danger cancel-job" not in html, "anonymous users get no cancel buttons"


def test_queue_route_cancel_button_gated_by_owner(client, login_session, monkeypatch):
    monkeypatch.setattr(subprocess, "run", fake_slurm_output([("squeue", SQUEUE_STDOUT)]))
    login_session("iana")
    html = client.get("/queue").get_data(as_text=True)
    own_row = html.split('data-job-id="123"')[1].split("</tr>")[0]
    other_row = html.split('data-job-id="124"')[1].split("</tr>")[0]
    assert "cancel-job" in own_row, "the owner sees a cancel button for their job"
    assert "cancel-job" not in other_row, "not for other users' jobs"


def test_queue_route_cancel_button_for_admin(client, login_session, monkeypatch):
    monkeypatch.setattr(subprocess, "run", fake_slurm_output([("squeue", SQUEUE_STDOUT)]))
    login_session("CBI_Admin")
    html = client.get("/queue").get_data(as_text=True)
    other_row = html.split('data-job-id="124"')[1].split("</tr>")[0]
    assert "cancel-job" in other_row, "CBI_Admin can cancel any job"


def test_queue_route_survives_broken_squeue(client, monkeypatch):
    def boom(*args, **kwargs):
        raise FileNotFoundError("squeue missing")
    monkeypatch.setattr(subprocess, "run", boom)
    resp = client.get("/queue")
    assert resp.status_code == 200
    html = resp.get_data(as_text=True)
    assert "iana_experiment" not in html, "a failed squeue must render an empty queue, not a 500"


def test_cancel_route(client, login_session, monkeypatch):
    fake = fake_slurm_output([])
    monkeypatch.setattr(subprocess, "run", fake)
    login_session("iana")
    resp = client.post("/cancel", json={"job_id": "4242"})
    assert resp.status_code == 200
    assert "cancelled" in resp.get_json()["message"]
    assert ["scancel", "4242"] in fake.calls


def test_get_user_path_derivation(peace_app):
    get_user = peace_app.get_user
    assert get_user("/h20/Public/dutta-p/experiment") == "dutta-p"
    assert get_user("/h20/Acquire/MesoSPIM/dutta-p/scan") == "dutta-p"
    assert get_user("/h20/Acquire/RSCM/other-x/x") == "other-x"
    assert get_user("/CBI_FastStore/Acquire/MesoSPIM/abc-y/x") == "abc-y"
    assert get_user("/CBI_FastStore/Acquire/RSCM/abc-y/x") == "abc-y"
    # usernames must match the lab naming pattern
    assert get_user("/h20/Public/UPPER-CASE/x") == ""
    assert get_user("/tmp/nowhere") == ""
    assert get_user("") == ""


def test_slurm_status_base_job_id(peace_app):
    from utils.slurm_status import _base_job_id
    assert _base_job_id("123_[1-9%4]") == "123"
    assert _base_job_id("789.0") == "789"
    assert _base_job_id(" 42 ") == "42"
    assert _base_job_id("") == ""
    assert _base_job_id(None) == ""


def test_slurm_status_normalize_state(peace_app):
    from utils.slurm_status import normalize_state
    assert normalize_state("R") == "running"
    assert normalize_state("PD") == "pending"
    assert normalize_state("CANCELLED by 1000") == "cancelled"
    assert normalize_state("TIMEOUT") == "failed"
    assert normalize_state("OUT_OF_MEMORY") == "failed"
    assert normalize_state("COMPLETED") == "finished successfully"
    assert normalize_state("SUSPENDED") == "paused"
    assert normalize_state("WEIRD") == "unknown"
    assert normalize_state(None) == "unknown"


def test_slurm_status_summarize_job_ids(peace_app):
    from utils.slurm_status import summarize_job_ids
    assert summarize_job_ids(["123_[1-9%4]"], {"123": "running"}) == "running"
    assert summarize_job_ids(["123"], {}) == "submitted", "falls back without state info"
    assert summarize_job_ids(["1", "2"], {"1": "finished successfully", "2": "running"}) == "running"
    assert summarize_job_ids([], {}, fallback="paused") == "paused"
