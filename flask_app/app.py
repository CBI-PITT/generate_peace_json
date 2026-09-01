import json
import copy
import importlib
import os
import re
import subprocess
from datetime import datetime

from flask import Flask, render_template, request, jsonify, redirect, url_for
from flask import flash
from flask_login import login_required, current_user
from werkzeug.utils import secure_filename

from operations import BaseOperation, BaseReader
from workflows import BaseWorkflow

# from flask_file_browser import extended_app
from flask_file_browser import routes
from auth import setup_auth, user_info
from config import ENABLE_JOB_HISTORY
from config import PORT
from utils.users import get_user
from utils.job_history import list_records
from utils.job_history import load_job_record
from utils.job_history import load_workflow_record
from utils.job_history import new_job_submission_payload
from utils.job_history import new_workflow_submission_payload
from utils.job_history import update_record
from utils.job_history import write_submission_json
from utils.slurm_status import query_job_states, summarize_job_ids


app = Flask(__name__)
app.config['SECRET_KEY'] = 'your_secret_key'
app.config['WTF_CSRF_ENABLED'] = False

app.template_folder = 'templates'
WORKFLOW_TEMPLATE_FOLDER = os.path.join(os.path.dirname(__file__), 'saved_workflows')

# Register the browser app blueprint
# app.register_blueprint(extended_app, url_prefix='/browser')
app = routes.init_blueprint(app, prefix="/browser")

app, login_manager = setup_auth(app)


# Discover and load plugins
def load_plugins(folder):
    plugins = {}
    full_path = os.path.join(os.path.dirname(__file__), folder)
    for filename in os.listdir(full_path):
        if os.path.isfile(os.path.join(full_path, filename)) and filename not in ["base.py", '__init__.py']:
            module_name = f"{folder}.{filename[:-3]}"
            module = importlib.import_module(module_name)
            for attr_name in dir(module):
                cls = getattr(module, attr_name)
                if isinstance(cls, type) and issubclass(cls, BaseOperation) and cls is not BaseOperation:
                    plugin_instance = cls()
                    plugins[plugin_instance.name] = plugin_instance
    return plugins


def load_reader_plugins(folder):
    plugins = {}
    full_path = os.path.join(os.path.dirname(__file__), folder)
    for filename in os.listdir(full_path):
        if os.path.isfile(os.path.join(full_path, filename)) and filename not in ["base.py", '__init__.py']:
            module_name = f"{folder}.{filename[:-3]}"
            module = importlib.import_module(module_name)
            for attr_name in dir(module):
                cls = getattr(module, attr_name)
                if isinstance(cls, type) and issubclass(cls, BaseReader) and cls is not BaseReader:
                    plugin_instance = cls()
                    plugins[plugin_instance.name] = plugin_instance
    return plugins


OPERATIONS = load_plugins('operations')
print("OPERATIONS:", OPERATIONS)

PLUGINS = load_plugins('plugins')
print("PLUGINS:", PLUGINS)

READER_PLUGINS = load_reader_plugins('reader_plugins')
print("READER PLUGINS:", READER_PLUGINS)


STATUS_PRIORITY = {
    'paused': 0,
    'running': 1,
    'pending': 2,
    'failed_to_dispatch': 3,
    'failed': 4,
    'cancelled': 5,
    'finished successfully': 6,
    'submitted': 7,
    'unknown': 8,
}


def get_op_descriptions(ops):
    descriptions = []
    for operation in ops:
        if operation in OPERATIONS:
            plugin = OPERATIONS.get(operation)
        elif operation in PLUGINS:
            plugin = PLUGINS.get(operation)
        elif operation in READER_PLUGINS:
            plugin = READER_PLUGINS.get(operation)
        descriptions.append(plugin.description)
    return descriptions


def get_op_categories(ops):
    categories = []
    for operation in ops:
        if operation in OPERATIONS:
            plugin = OPERATIONS.get(operation)
        elif operation in PLUGINS:
            plugin = PLUGINS.get(operation)
        elif operation in READER_PLUGINS:
            plugin = READER_PLUGINS.get(operation)
        categories.append(plugin.category)
    return categories


def get_history_user():
    return current_user.get_id() or 'anonymous'


def can_manage_record(record):
    user = current_user.get_id()
    if not current_user.is_authenticated or not user or not record:
        return False
    return user == 'CBI_Admin' or record.get('submitted_by') == user


def collect_workflow_job_ids(record):
    job_ids = []
    for step in record.get('steps', []):
        for job_id in step.get('slurm_job_ids', []):
            if job_id not in job_ids:
                job_ids.append(job_id)
    return job_ids


def best_status(statuses, fallback='submitted'):
    filtered = [status for status in statuses if status]
    if not filtered:
        return fallback
    return sorted(filtered, key=lambda x: STATUS_PRIORITY.get(x, 99))[0]


def enrich_job_record(record, state_map):
    enriched = copy.deepcopy(record)
    enriched['current_status'] = summarize_job_ids(
        enriched.get('slurm_job_ids', []),
        state_map,
        fallback=enriched.get('status', 'submitted')
    )
    return enriched


def enrich_workflow_record(record, state_map):
    enriched = copy.deepcopy(record)
    step_statuses = []
    for step in enriched.get('steps', []):
        step['current_status'] = summarize_job_ids(
            step.get('slurm_job_ids', []),
            state_map,
            fallback=step.get('status', 'submitted')
        )
        step_statuses.append(step['current_status'])
    enriched['current_status'] = best_status(step_statuses, fallback=enriched.get('status', 'submitted'))
    return enriched


def get_home_history():
    if not ENABLE_JOB_HISTORY or not current_user.is_authenticated:
        return [], []

    user = get_history_user()
    jobs = list_records('job', user)
    workflows = list_records('workflow', user)
    all_job_ids = []
    for record in jobs:
        all_job_ids.extend(record.get('slurm_job_ids', []))
    for record in workflows:
        all_job_ids.extend(collect_workflow_job_ids(record))
    state_map = query_job_states(all_job_ids)
    return [enrich_job_record(record, state_map) for record in jobs], [enrich_workflow_record(record, state_map) for record in workflows]


def run_control_command(command, job_ids):
    normalized_job_ids = []
    for job_id in job_ids:
        job_text = str(job_id).strip()
        if not job_text:
            continue
        match = re.match(r'^(\d+)', job_text)
        normalized = match.group(1) if match else job_text
        if normalized not in normalized_job_ids:
            normalized_job_ids.append(normalized)
    if not normalized_job_ids:
        raise ValueError('No SLURM jobs have been submitted for this record yet')
    result = subprocess.run(command + normalized_job_ids, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or 'SLURM command failed')
    return normalized_job_ids


def rerun_job_record(record):
    payload = record.get('submission_payload') or {}
    prefix = 'SLURM_reader' if (record.get('submission_json_name') or '').startswith('SLURM_reader_') else 'SLURM_settings'
    new_payload, file_name = new_job_submission_payload(
        payload.get('input'),
        payload.get('output'),
        payload.get('operation'),
        copy.deepcopy(payload.get('extras', {})),
        record.get('submitted_by') or get_history_user(),
        rerun_of=record.get('job_record_id'),
        prefix=prefix
    )
    write_submission_json(file_name, new_payload)
    return new_payload


def resolve_forked_workflow_steps(record, start_step_id):
    submission_payload = record.get('submission_payload') or {}
    original_steps = copy.deepcopy(submission_payload.get('steps', []))
    step_history_map = {step.get('step_id'): step for step in record.get('steps', [])}
    start_index = None
    for index, step in enumerate(original_steps):
        if step.get('step_id') == start_step_id:
            start_index = index
            break
    if start_index is None:
        raise ValueError('Workflow step not found')

    subset = original_steps[start_index:]
    resolved_steps = []
    previous_outputs = []

    for index, step in enumerate(subset):
        step_history = step_history_map.get(step.get('step_id')) or {}
        resolved_extras = copy.deepcopy(step_history.get('resolved_extras') or {})
        extras = copy.deepcopy(step.get('extras', {}))
        bindings = copy.deepcopy(step.get('input_bindings', {}))
        new_bindings = {}

        for field_name, output_name in bindings.items():
            if output_name in previous_outputs:
                new_bindings[field_name] = output_name
                continue
            if field_name == 'input' and step_history.get('resolved_input'):
                extras[field_name] = step_history.get('resolved_input')
            elif field_name in resolved_extras:
                extras[field_name] = resolved_extras[field_name]

        if index == 0:
            if resolved_extras:
                extras = resolved_extras
            new_bindings = {}

        normalized_step = copy.deepcopy(step)
        normalized_step['step_id'] = None
        normalized_step['extras'] = extras
        normalized_step['input_bindings'] = new_bindings
        resolved_steps.append(normalized_step)
        previous_outputs.append(step.get('output_name'))

    return resolved_steps


def rerun_workflow_record(record, start_step_id=None):
    submission_payload = record.get('submission_payload') or {}
    if start_step_id:
        steps = resolve_forked_workflow_steps(record, start_step_id)
    else:
        steps = copy.deepcopy(submission_payload.get('steps', []))
        for step in steps:
            step['step_id'] = None
    new_payload, file_name = new_workflow_submission_payload(
        steps,
        record.get('submitted_by') or get_history_user(),
        rerun_of=record.get('workflow_id')
    )
    write_submission_json(file_name, new_payload)
    return new_payload


@app.route('/')
def index():
    my_jobs, my_workflows = get_home_history()
    return render_template(
        'index.html',
        operations=[],
        enable_job_history=ENABLE_JOB_HISTORY,
        my_jobs=my_jobs,
        my_workflows=my_workflows,
    )


@app.route('/categories')
def categories():
    operations = list(OPERATIONS.keys())
    operations.extend(PLUGINS.keys())
    categories = list(set(get_op_categories(operations)))
    return render_template('categories.html', categories=categories)


@app.route('/analyze/<category>')
def analyze(category):
    # operations = list(OPERATIONS.keys())
    # operations.extend(PLUGINS.keys())
    operations = OPERATIONS.copy()
    operations.update(PLUGINS.copy())
    operations = [x for x in operations.keys() if operations[x].category == category]
    descriptions = get_op_descriptions(operations)
    return render_template('operations.html', operations=operations, descriptions=descriptions)


@app.route('/read')
def read():
    operations = list(READER_PLUGINS.keys())
    descriptions = get_op_descriptions(operations)
    return render_template('operations.html', operations=operations, descriptions=descriptions)


@app.route('/operation/<operation>', methods=['GET', 'POST'])
@login_required
def operation_form(operation):
    if operation in OPERATIONS:
        # load default operations
        plugin = OPERATIONS.get(operation)
    elif operation in PLUGINS:
        # load plugins
        plugin = PLUGINS.get(operation)
    elif operation in READER_PLUGINS:
        # load reader plugins
        plugin = READER_PLUGINS.get(operation)
    else:
        return f"Operation '{operation}' not supported", 404
    form_class = plugin.get_form()
    form = form_class()
    template = plugin.get_template()
    if request.method == 'POST':
        form = form_class(request.form)
        if form.validate():
            # Process the form data
            plugin.process_data(form)
            # Flash a success message
            flash(f"{operation.capitalize()} task created successfully", "success")
            # Redirect to the home page
            return redirect(url_for('index'))

    return render_template(template, form=form, operation=operation)


@app.route('/queue')
def slurm_queue():
    jobs = []

    import subprocess
    try:
        result = subprocess.run(["squeue", "--format=%i %u %j %P %t %M %Q"], capture_output=True, text=True)
        lines = result.stdout.strip().split("\n")

        for line in lines[1:]:  # Skip the first line (header)
            job_id, user, job_name, partition, state, time, nodes = line.split(maxsplit=6)
            jobs.append({
                "Job ID": job_id,
                "User": user,
                "Job Name": job_name,
                "Partition": partition,
                "State": state,
                "Time": time,
                "Nodes": nodes
            })
    except:
        print("ERROR: Couldn't get job list")
    return render_template('queue.html', queue=jobs)


@app.route('/get_output_dir', methods=['POST'])
def get_output_dir():
    input_dir = request.json.get('input')
    try:
        return jsonify({'output': get_input_base_output_dir(input_dir) or ''})
    except Exception as e:
        return jsonify({'output': '', 'error': str(e)}), 400


def get_input_base_output_dir(input_dir):
    dataset_info_path = os.path.join(input_dir, '.dataset_info.json')
    with open(dataset_info_path, 'r') as f:
        data = json.load(f)
    return data.get('base_output_dir', '')


def udpdate_steps(workflow):
    """
    Custom logic to make workflow JSON compatible with PEACE backend
    """
    user = current_user.get_id()
    if user == "CBI_Admin" or not user:
        all_inputs = [x['extras'].get('input', "") for x in workflow.steps]
        all_inputs = [get_user(x) for x in all_inputs if x != ""]
        all_inputs = [x for x in all_inputs if x != ""]
        if len(all_inputs) >= 1:
            user = all_inputs[0]

    for step in workflow.steps:
        if not step['extras'].get('output') and step['extras'].get('input'):
            try:
                derived_output = get_input_base_output_dir(step['extras']['input'])
            except Exception:
                derived_output = ''
            if derived_output:
                step['extras']['output'] = derived_output
        if user:
            step['extras']['user'] = user
        if step['operation'] in ['brainreg', 'ants']:
            orientation1 = step['extras'].pop('orientation-select1')
            orientation2 = step['extras'].pop('orientation-select2')
            orientation3 = step['extras'].pop('orientation-select3')
            orientation = orientation1[0] + orientation2[0] + orientation3[0]
            step['extras']['orientation'] = orientation
            print(step['extras'])
        elif step['operation'] == 'combine_with_metadata':
            metadata = []
            metadata_keys = sorted([x for x in step['extras'].keys() if x.startswith("metadata")])
            metadata_keys_len = len(metadata_keys)
            for key_ind in range(0, metadata_keys_len, 2):
                metadata_dict = {}
                metadata_dict["key"] = step['extras'].pop(metadata_keys[key_ind])
                metadata_dict["value"] = step['extras'].pop(metadata_keys[key_ind + 1])
                metadata.append(metadata_dict)
            step['extras']['metadata'] = metadata
            print(step['extras'])
    return workflow


def save_to_json(workflow):
    user = current_user.get_id() or 'anonymous'
    wf_data, file_name = new_workflow_submission_payload(workflow.steps, user)
    workflow.workflow_id = wf_data['workflow_id']
    workflow.steps = copy.deepcopy(wf_data['steps'])
    write_submission_json(file_name, wf_data)


def get_user_workflow_template_dir():
    user = secure_filename(current_user.get_id() or 'anonymous')
    template_dir = os.path.join(WORKFLOW_TEMPLATE_FOLDER, user)
    os.makedirs(template_dir, exist_ok=True)
    return template_dir


def get_workflow_template_path(name):
    template_name = secure_filename(name or '')
    if not template_name:
        raise ValueError('Template name is required')
    if not template_name.endswith('.json'):
        template_name = f'{template_name}.json'
    return os.path.join(get_user_workflow_template_dir(), template_name)


def list_workflow_templates():
    template_dir = get_user_workflow_template_dir()
    templates = []
    for filename in sorted(os.listdir(template_dir)):
        if not filename.endswith('.json'):
            continue
        file_path = os.path.join(template_dir, filename)
        try:
            with open(file_path, 'r') as f:
                data = json.load(f)
        except Exception:
            continue
        templates.append({
            'name': data.get('name') or os.path.splitext(filename)[0],
            'slug': os.path.splitext(filename)[0],
            'updated_at': data.get('updated_at')
        })
    return templates


def save_workflow_template(name, workflow_data):
    file_path = get_workflow_template_path(name)
    payload = {
        'name': name,
        'owner': current_user.get_id(),
        'updated_at': datetime.now().isoformat(),
        'workflow': workflow_data,
    }
    with open(file_path, 'w') as f:
        json.dump(payload, f, indent=2)
    os.chmod(file_path, 0o664)
    return payload


def load_workflow_template(name):
    file_path = get_workflow_template_path(name)
    if not os.path.exists(file_path):
        return None
    with open(file_path, 'r') as f:
        return json.load(f)


def delete_workflow_template(name):
    file_path = get_workflow_template_path(name)
    if not os.path.exists(file_path):
        return False
    os.remove(file_path)
    return True


@app.route("/workflow/new", methods=["GET", "POST"])
@login_required
def create_workflow():
    if request.method == "POST":
        data = request.get_json()
        workflow = BaseWorkflow()
        for step in data["steps"]:
            workflow.add_step(
                input=step["input"],
                output=step["output"],
                operation=step["operation"],
                extras=step["extras"],
                step_id=step.get('step_id')
            )
        workflow = udpdate_steps(workflow)
        save_to_json(workflow)
        return jsonify({"status": "ok"})

    # Provide available operations to dropdown
    all_operations = {}
    all_operations.update(OPERATIONS)
    all_operations.update(PLUGINS)
    categories = get_op_categories(all_operations.keys())
    available_ops = {}
    available_ops['readers'] = READER_PLUGINS.keys()
    for category in categories:
        category_ops = [x for x in all_operations.keys() if all_operations[x].category == category]
        available_ops[category] = category_ops
    return render_template("create_workflow.html", available_operations=available_ops)


@app.route('/workflow/templates', methods=['GET'])
@login_required
def workflow_templates():
    return jsonify({'templates': list_workflow_templates()})


@app.route('/workflow/templates/save', methods=['POST'])
@login_required
def save_workflow_template_route():
    data = request.get_json() or {}
    name = (data.get('name') or '').strip()
    workflow_data = data.get('workflow') or {}

    if not name:
        return jsonify({'error': 'Template name is required'}), 400
    if not isinstance(workflow_data, dict) or not isinstance(workflow_data.get('steps'), list):
        return jsonify({'error': 'Workflow must include a steps list'}), 400

    payload = save_workflow_template(name, workflow_data)
    return jsonify({'status': 'ok', 'template': {'name': payload['name'], 'slug': secure_filename(name)}})


@app.route('/workflow/templates/<template_name>', methods=['GET'])
@login_required
def get_workflow_template_route(template_name):
    template_data = load_workflow_template(template_name)
    if template_data is None:
        return jsonify({'error': 'Template not found'}), 404
    return jsonify(template_data)


@app.route('/workflow/templates/<template_name>/delete', methods=['POST'])
@login_required
def delete_workflow_template_route(template_name):
    if not delete_workflow_template(template_name):
        return jsonify({'error': 'Template not found'}), 404
    return jsonify({'status': 'ok'})


def render_operation_form(operation, as_fragment=True):
    # Dynamically get the form class and instantiate it
    if operation in OPERATIONS:
        # load default operations
        plugin = OPERATIONS.get(operation)
    elif operation in PLUGINS:
        # load plugins
        plugin = PLUGINS.get(operation)
    elif operation in READER_PLUGINS:
        # load reader plugins
        plugin = READER_PLUGINS.get(operation)
    else:
        return f"Operation '{operation}' not supported", 404
    form_class = plugin.get_form()
    form = form_class()

    if not as_fragment:
        return render_template("form.html", form=form)

    if operation in READER_PLUGINS:
        return render_template('form_fragment.html', form=form)
    else:
        return render_template('form_fragment_no_output.html', form=form)


@app.route("/workflow/operation_form", methods=["POST"])
def get_operation_form():
    operation = request.form["operation"]
    form_html = render_operation_form(operation, as_fragment=True)
    return jsonify({"form_html": form_html})


@app.route('/history/job/<job_record_id>/cancel', methods=['POST'])
@login_required
def cancel_history_job(job_record_id):
    if not ENABLE_JOB_HISTORY:
        return jsonify({'message': 'Job history feature is disabled'}), 404
    record = load_job_record(get_history_user(), job_record_id)
    if not can_manage_record(record):
        return jsonify({'message': 'Not authorized'}), 403
    try:
        run_control_command(['scancel'], record.get('slurm_job_ids', []))
        update_record(record['history_file'], {'status': 'cancelled'})
        return jsonify({'message': 'Job cancelled'})
    except Exception as e:
        return jsonify({'message': str(e)}), 500


@app.route('/history/job/<job_record_id>/hold', methods=['POST'])
@login_required
def hold_history_job(job_record_id):
    if not ENABLE_JOB_HISTORY:
        return jsonify({'message': 'Job history feature is disabled'}), 404
    record = load_job_record(get_history_user(), job_record_id)
    if not can_manage_record(record):
        return jsonify({'message': 'Not authorized'}), 403
    try:
        run_control_command(['scontrol', 'hold'], record.get('slurm_job_ids', []))
        update_record(record['history_file'], {'status': 'paused'})
        return jsonify({'message': 'Job held'})
    except Exception as e:
        return jsonify({'message': str(e)}), 500


@app.route('/history/job/<job_record_id>/release', methods=['POST'])
@login_required
def release_history_job(job_record_id):
    if not ENABLE_JOB_HISTORY:
        return jsonify({'message': 'Job history feature is disabled'}), 404
    record = load_job_record(get_history_user(), job_record_id)
    if not can_manage_record(record):
        return jsonify({'message': 'Not authorized'}), 403
    try:
        run_control_command(['scontrol', 'release'], record.get('slurm_job_ids', []))
        update_record(record['history_file'], {'status': 'submitted'})
        return jsonify({'message': 'Job released'})
    except Exception as e:
        return jsonify({'message': str(e)}), 500


@app.route('/history/job/<job_record_id>/rerun', methods=['POST'])
@login_required
def rerun_history_job(job_record_id):
    if not ENABLE_JOB_HISTORY:
        return jsonify({'message': 'Job history feature is disabled'}), 404
    record = load_job_record(get_history_user(), job_record_id)
    if not can_manage_record(record):
        return jsonify({'message': 'Not authorized'}), 403
    new_payload = rerun_job_record(record)
    return jsonify({'message': 'Job re-submitted', 'job_record_id': new_payload.get('job_record_id')})


@app.route('/history/workflow/<workflow_id>/cancel', methods=['POST'])
@login_required
def cancel_history_workflow(workflow_id):
    if not ENABLE_JOB_HISTORY:
        return jsonify({'message': 'Job history feature is disabled'}), 404
    record = load_workflow_record(get_history_user(), workflow_id)
    if not can_manage_record(record):
        return jsonify({'message': 'Not authorized'}), 403
    try:
        run_control_command(['scancel'], collect_workflow_job_ids(record))
        for step in record.get('steps', []):
            step['status'] = 'cancelled'
        update_record(record['history_file'], {'status': 'cancelled', 'steps': record.get('steps', [])})
        return jsonify({'message': 'Workflow cancelled'})
    except Exception as e:
        return jsonify({'message': str(e)}), 500


@app.route('/history/workflow/<workflow_id>/hold', methods=['POST'])
@login_required
def hold_history_workflow(workflow_id):
    if not ENABLE_JOB_HISTORY:
        return jsonify({'message': 'Job history feature is disabled'}), 404
    record = load_workflow_record(get_history_user(), workflow_id)
    if not can_manage_record(record):
        return jsonify({'message': 'Not authorized'}), 403
    try:
        run_control_command(['scontrol', 'hold'], collect_workflow_job_ids(record))
        for step in record.get('steps', []):
            step['status'] = 'paused'
        update_record(record['history_file'], {'status': 'paused', 'steps': record.get('steps', [])})
        return jsonify({'message': 'Workflow held'})
    except Exception as e:
        return jsonify({'message': str(e)}), 500


@app.route('/history/workflow/<workflow_id>/release', methods=['POST'])
@login_required
def release_history_workflow(workflow_id):
    if not ENABLE_JOB_HISTORY:
        return jsonify({'message': 'Job history feature is disabled'}), 404
    record = load_workflow_record(get_history_user(), workflow_id)
    if not can_manage_record(record):
        return jsonify({'message': 'Not authorized'}), 403
    try:
        run_control_command(['scontrol', 'release'], collect_workflow_job_ids(record))
        for step in record.get('steps', []):
            step['status'] = 'submitted'
        update_record(record['history_file'], {'status': 'submitted', 'steps': record.get('steps', [])})
        return jsonify({'message': 'Workflow released'})
    except Exception as e:
        return jsonify({'message': str(e)}), 500


@app.route('/history/workflow/<workflow_id>/rerun', methods=['POST'])
@login_required
def rerun_history_workflow(workflow_id):
    if not ENABLE_JOB_HISTORY:
        return jsonify({'message': 'Job history feature is disabled'}), 404
    record = load_workflow_record(get_history_user(), workflow_id)
    if not can_manage_record(record):
        return jsonify({'message': 'Not authorized'}), 403
    new_payload = rerun_workflow_record(record)
    return jsonify({'message': 'Workflow re-submitted', 'workflow_id': new_payload.get('workflow_id')})


@app.route('/history/workflow/<workflow_id>/steps/<step_id>/rerun', methods=['POST'])
@login_required
def rerun_history_workflow_step(workflow_id, step_id):
    if not ENABLE_JOB_HISTORY:
        return jsonify({'message': 'Job history feature is disabled'}), 404
    record = load_workflow_record(get_history_user(), workflow_id)
    if not can_manage_record(record):
        return jsonify({'message': 'Not authorized'}), 403
    new_payload = rerun_workflow_record(record, start_step_id=step_id)
    return jsonify({'message': 'Workflow fork re-submitted', 'workflow_id': new_payload.get('workflow_id')})


@app.route("/cancel", methods=["POST"])
@login_required
def cancel_job():
    data = request.get_json()
    job_id = data.get("job_id")

    if not job_id:
        return jsonify({"message": "Missing job ID"}), 400

    try:
        result = subprocess.run(["scancel", str(job_id)], capture_output=True, text=True)
        if result.returncode != 0:
            return jsonify({"message": f"Failed to cancel job: {result.stderr}"}), 500
        return jsonify({"message": f"Job {job_id} cancelled successfully."})
    except Exception as e:
        return jsonify({"message": str(e)}), 500


if __name__ == '__main__':
    app.run(host="0.0.0.0", port=PORT, debug=True)
