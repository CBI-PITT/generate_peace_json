import re
import subprocess

from config import USE_SACCT_FOR_HISTORY


def _base_job_id(job_id):
    text = str(job_id or '').strip()
    if not text:
        return ''
    if '_' in text:
        text = text.split('_', 1)[0]
    if '.' in text:
        text = text.split('.', 1)[0]
    match = re.match(r'^(\d+)', text)
    return match.group(1) if match else text


def _run_command(command):
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        return []
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def _state_priority(state):
    priorities = {
        'paused': 0,
        'running': 1,
        'pending': 2,
        'failed': 3,
        'cancelled': 4,
        'finished successfully': 5,
        'submitted': 6,
        'unknown': 7,
    }
    return priorities.get(state, 7)


def normalize_state(slurm_state):
    state = (slurm_state or '').strip().upper()
    if state in ('PD', 'PENDING', 'CONFIGURING'):
        return 'pending'
    if state in ('R', 'RUNNING', 'COMPLETING'):
        return 'running'
    if state in ('S', 'SUSPENDED', 'STOPPED', 'H', 'HOLD', 'SPECIAL_EXIT', 'REQUEUED_HOLD'):
        return 'paused'
    if state.startswith('CANCELLED') or state == 'CA':
        return 'cancelled'
    if state in ('COMPLETED', 'CD'):
        return 'finished successfully'
    if state in ('FAILED', 'F', 'TIMEOUT', 'TO', 'OUT_OF_MEMORY', 'OOM', 'NODE_FAIL', 'NF', 'BOOT_FAIL', 'BF', 'DEADLINE', 'DL', 'PREEMPTED', 'PR'):
        return 'failed'
    return 'unknown'


def query_job_states(job_ids):
    normalized_ids = []
    for job_id in job_ids:
        base_id = _base_job_id(job_id)
        if base_id and base_id not in normalized_ids:
            normalized_ids.append(base_id)

    if not normalized_ids:
        return {}

    states = {}

    for line in _run_command(['squeue', '-h', '-o', '%i|%T', '-j', ','.join(normalized_ids)]):
        parts = line.split('|', 1)
        if len(parts) != 2:
            continue
        job_id = _base_job_id(parts[0])
        if not job_id:
            continue
        states[job_id] = normalize_state(parts[1])

    if USE_SACCT_FOR_HISTORY:
        for line in _run_command(['sacct', '-n', '-P', '-X', '-o', 'JobIDRaw,State', '-j', ','.join(normalized_ids)]):
            parts = line.split('|', 1)
            if len(parts) != 2:
                continue
            job_id = _base_job_id(parts[0])
            if not job_id or states.get(job_id) in ('running', 'pending', 'paused'):
                continue
            states[job_id] = normalize_state(parts[1])

    return states


def summarize_job_ids(job_ids, state_map, fallback='submitted'):
    statuses = []
    for job_id in job_ids:
        base_id = _base_job_id(job_id)
        if base_id:
            statuses.append(state_map.get(base_id, 'unknown'))
    statuses = [status for status in statuses if status != 'unknown']
    if not statuses:
        return fallback
    return sorted(statuses, key=_state_priority)[0]
