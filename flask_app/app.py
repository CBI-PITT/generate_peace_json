import json
import importlib
import os

from flask import Flask, render_template, request, jsonify, redirect, url_for
from flask import flash

from operations import BaseOperation, BaseReader

# from flask_file_browser import extended_app
from flask_file_browser import routes


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
    print("Inside the view")
    print("request.json", request.json)
    input_dir = request.json.get('input')
    dataset_info_path = os.path.join(input_dir, '.dataset_info.json')

    try:
        with open(dataset_info_path, 'r') as f:
            data = json.load(f)
            return jsonify({'output': data.get('base_output_dir', '')})
    except Exception as e:
        return jsonify({'output': '', 'error': str(e)}), 400


if __name__ == '__main__':
    app.run(host="0.0.0.0", port=1313, debug=True)
