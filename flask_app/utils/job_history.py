import copy
import json
import os
import tempfile
import uuid
from datetime import datetime

from werkzeug.utils import secure_filename

from config import ENABLE_JOB_HISTORY, JOB_HISTORY_DIR, JSON_FOLDER


def history_enabled():
    return ENABLE_JOB_HISTORY


def _safe_user(user):
    return secure_filename(user or 'anonymous') or 'anonymous'


def _write_json(path, payload):
    parent = os.path.dirname(path)
    os.makedirs(parent, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix='.tmp_history_', dir=parent)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(payload, f, indent=2)
        os.replace(tmp_path, path)
        os.chmod(path, 0o664)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


def _record_path(kind, user, record_id):
    folder = 'jobs' if kind == 'job' else 'workflows'
    return os.path.join(JOB_HISTORY_DIR, folder, _safe_user(user), f'{record_id}.json')


def _submission_json_path(name):
    return os.path.join(JSON_FOLDER, name)


def create_job_payload_record(json_payload, rerun_of=None):
    submitted_by = json_payload.get('submitted_by') or 'anonymous'
    record_id = json_payload['job_record_id']
    record = {
        'kind': 'job',
        'job_record_id': record_id,
        'submitted_by': submitted_by,
        'submitted_at': json_payload.get('submitted_at') or datetime.now().isoformat(),
        'rerun_of': rerun_of,
        'submission_json_name': os.path.basename(json_payload.get('submission_json', '')),
        'submission_json_path': json_payload.get('submission_json'),
        'operation': json_payload.get('operation'),
        'input': json_payload.get('input'),
        'output': json_payload.get('output'),
        'extras': copy.deepcopy(json_payload.get('extras', {})),
        'status': 'submitted',
        'slurm_job_ids': [],
        'provenance_path': None,
        'log_folder': None,
        'dispatch_error': None,
        'submission_payload': copy.deepcopy(json_payload),
    }
    path = _record_path('job', submitted_by, record_id)
    record['history_file'] = path
    _write_json(path, record)
    return record


def create_workflow_payload_record(workflow_payload, rerun_of=None):
    submitted_by = workflow_payload.get('submitted_by') or 'anonymous'
    workflow_id = workflow_payload['workflow_id']
    steps = []
    for step in workflow_payload.get('steps', []):
        steps.append({
            'step_id': step.get('step_id'),
            'operation': step.get('operation'),
            'status': 'submitted',
            'input_bindings': copy.deepcopy(step.get('input_bindings', {})),
            'output_name': step.get('output_name'),
            'extras': copy.deepcopy(step.get('extras', {})),
            'slurm_job_ids': [],
            'provenance_path': None,
            'log_folder': None,
            'dispatch_error': None,
            'resolved_input': None,
            'resolved_output': None,
            'resolved_extras': None,
        })
    record = {
        'kind': 'workflow',
        'workflow_id': workflow_id,
        'submitted_by': submitted_by,
        'submitted_at': workflow_payload.get('submitted_at') or datetime.now().isoformat(),
        'rerun_of': rerun_of,
        'submission_json_name': os.path.basename(workflow_payload.get('submission_json', '')),
        'submission_json_path': workflow_payload.get('submission_json'),
        'status': 'submitted',
        'dispatch_error': None,
        'steps': steps,
        'submission_payload': copy.deepcopy(workflow_payload),
    }
    path = _record_path('workflow', submitted_by, workflow_id)
    record['history_file'] = path
    _write_json(path, record)
    return record


def update_record(path, updates):
    if not path or not os.path.exists(path):
        return None
    with open(path, 'r') as f:
        record = json.load(f)
    record.update(copy.deepcopy(updates))
    _write_json(path, record)
    return record


def load_record(path):
    if not path or not os.path.exists(path):
        return None
    with open(path, 'r') as f:
        return json.load(f)


def load_job_record(user, job_record_id):
    return load_record(_record_path('job', user, job_record_id))


def load_workflow_record(user, workflow_id):
    return load_record(_record_path('workflow', user, workflow_id))


def list_records(kind, user):
    folder = 'jobs' if kind == 'job' else 'workflows'
    root = os.path.join(JOB_HISTORY_DIR, folder, _safe_user(user))
    if not os.path.isdir(root):
        return []
    records = []
    for filename in sorted(os.listdir(root), reverse=True):
        if not filename.endswith('.json'):
            continue
        record = load_record(os.path.join(root, filename))
        if record is not None:
            records.append(record)
    records.sort(key=lambda x: x.get('submitted_at', ''), reverse=True)
    return records


def new_job_submission_payload(input_path, output_path, operation, extras, submitted_by, rerun_of=None, prefix='SLURM_settings'):
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    job_record_id = str(uuid.uuid4())
    file_name = f'{prefix}_{timestamp}_{job_record_id[:8]}.json'
    payload = {
        'input': input_path,
        'output': output_path,
        'operation': operation,
        'extras': copy.deepcopy(extras),
        'job_record_id': job_record_id,
        'submitted_by': submitted_by,
        'submitted_at': datetime.now().isoformat(),
        'rerun_of': rerun_of,
        'submission_json': _submission_json_path(file_name),
    }
    if history_enabled():
        record = create_job_payload_record(payload, rerun_of=rerun_of)
        payload['history_file'] = record['history_file']
        record = update_record(record['history_file'], {'submission_payload': copy.deepcopy(payload)})
    return payload, file_name


def new_workflow_submission_payload(steps, submitted_by, rerun_of=None):
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    workflow_id = str(uuid.uuid4())
    file_name = f'SLURM_workflow_{timestamp}_{workflow_id[:8]}.json'
    normalized_steps = []
    for step in steps:
        normalized_step = copy.deepcopy(step)
        normalized_step['step_id'] = normalized_step.get('step_id') or str(uuid.uuid4())
        normalized_steps.append(normalized_step)
    payload = {
        'workflow_id': workflow_id,
        'submitted_by': submitted_by,
        'submitted_at': datetime.now().isoformat(),
        'rerun_of': rerun_of,
        'steps': normalized_steps,
        'submission_json': _submission_json_path(file_name),
    }
    if history_enabled():
        record = create_workflow_payload_record(payload, rerun_of=rerun_of)
        payload['history_file'] = record['history_file']
        record = update_record(record['history_file'], {'submission_payload': copy.deepcopy(payload)})
    return payload, file_name


def write_submission_json(file_name, payload):
    path = _submission_json_path(file_name)
    _write_json(path, payload)
    return path
