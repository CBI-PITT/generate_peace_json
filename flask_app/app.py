import importlib
import os

from flask import Flask, render_template, request, jsonify, redirect, url_for
from flask import flash

from operations import BaseOperation


app = Flask(__name__)
app.config['SECRET_KEY'] = 'your_secret_key'


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


OPERATIONS = load_plugins('operations')
print("OPERATIONS:", OPERATIONS)

PLUGINS = load_plugins('plugins')
print("PLUGINS:", PLUGINS)


@app.route('/')
def index():
    operations = list(OPERATIONS.keys())
    operations.extend(PLUGINS.keys())
    return render_template('index.html', operations=operations)


@app.route('/operation/<operation>', methods=['GET', 'POST'])
def operation_form(operation):
    if operation in OPERATIONS:
        # load default operations
        plugin = OPERATIONS.get(operation)
    elif operation in PLUGINS:
        # load plugins
        plugin = PLUGINS.get(operation)
    else:
        return f"Operation '{operation}' not supported", 404
    form_class = plugin.get_form()
    form = form_class()
    if request.method == 'POST' and form.validate():
        # Process the form data
        plugin.process_data(form)
        # Flash a success message
        flash(f"{operation.capitalize()} task created successfully", "success")
        # Redirect to the home page
        return redirect(url_for('index'))

    return render_template('form.html', form=form, operation=operation)


if __name__ == '__main__':
    app.run(debug=True)
