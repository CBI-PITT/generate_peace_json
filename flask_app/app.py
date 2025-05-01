import json
import importlib
import os
from datetime import datetime

from flask import Flask, render_template, request, jsonify, redirect, url_for
from flask import flash
from flask import render_template_string

from operations import BaseOperation, BaseReader
from workflows import BaseWorkflow

# from flask_file_browser import extended_app
from flask_file_browser import routes
from config import JSON_FOLDER


app = Flask(__name__)
app.config['SECRET_KEY'] = 'your_secret_key'
app.config['WTF_CSRF_ENABLED'] = False

app.template_folder = 'templates'

# Register the browser app blueprint
# app.register_blueprint(extended_app, url_prefix='/browser')
app = routes.init_blueprint(app, prefix="/browser")


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


@app.route('/')
def index():
    return render_template('index.html', operations=[])


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
    dataset_info_path = os.path.join(input_dir, '.dataset_info.json')

    try:
        with open(dataset_info_path, 'r') as f:
            data = json.load(f)
            return jsonify({'output': data.get('base_output_dir', '')})
    except Exception as e:
        return jsonify({'output': '', 'error': str(e)}), 400


def udpdate_steps(workflow):
    """
    Custom logic to make workflow JSON compatible with PEACE backend
    """
    for step in workflow.steps:
        if step['operation'] == 'brainreg':
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
    wf_data = {"steps": workflow.steps}
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    fname = f"SLURM_workflow_{timestamp}.json"
    json_file_path = os.path.join(JSON_FOLDER, fname)
    with open(json_file_path, "w") as f:
        json.dump(wf_data, f, indent=2)
    os.chmod(json_file_path, 0o664)


@app.route("/workflow/new", methods=["GET", "POST"])
def create_workflow():
    if request.method == "POST":
        data = request.get_json()
        workflow = BaseWorkflow()
        for step in data["steps"]:
            workflow.add_step(
                input=step["input"],
                output=step["output"],
                operation=step["operation"],
                extras=step["extras"]
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


if __name__ == '__main__':
    app.run(host="0.0.0.0", port=1313, debug=True)
