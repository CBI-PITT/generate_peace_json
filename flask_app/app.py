import importlib
import os

from flask import Flask, render_template, request, jsonify, redirect, url_for
from flask import flash

from forms import BaseForm, DeepBlinkForm, BrainRegForm, CellFinderForm, AntsForm, ContrastStretchForm
from plugins import BasePlugin

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your_secret_key'

# Operation forms dictionary
OPERATION_FORMS = {
    "deepblink": DeepBlinkForm,
    "brainreg": BrainRegForm,
    "cellfinder": CellFinderForm,
    "ants": AntsForm,
    "stretch_contrast": ContrastStretchForm
}

# Plugin registry
PLUGINS = {}


# Discover and load plugins
def load_plugins():
    plugins_path = os.path.join(os.path.dirname(__file__), 'plugins')
    for filename in os.listdir(plugins_path):
        if filename.endswith("_plugin.py"):
            module_name = f"plugins.{filename[:-3]}"
            module = importlib.import_module(module_name)
            for attr_name in dir(module):
                cls = getattr(module, attr_name)
                if isinstance(cls, type) and issubclass(cls, BasePlugin) and cls is not BasePlugin:
                    plugin_instance = cls()
                    PLUGINS[plugin_instance.name] = plugin_instance


load_plugins()
print("PLUGINS", PLUGINS)


@app.route('/')
def index():
    operations = list(OPERATION_FORMS.keys())
    operations.extend(PLUGINS.keys())
    return render_template('index.html', operations=operations)


@app.route('/operation/<operation>', methods=['GET', 'POST'])
def operation_form(operation):
    if operation not in OPERATION_FORMS:
        plugin = PLUGINS.get(operation)
        if not plugin:
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
    else:
        form_class = OPERATION_FORMS[operation]
        form = form_class()
        if form.validate_on_submit():
            # Gather data into a JSON file
            json_data = {
                "input": form.input.data,
                "output": form.output.data,
                "operation": operation,
                "extras": {}
            }
            data = {field.name: field.data for field in form if field.name not in ["submit", "csrf_token", "input", "output", "operation"]}
            json_data["extras"] = data
            # Save the JSON data to a file
            from datetime import datetime
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            with open(f'/h20/CBI/Iana/json/SLURM_settings_{timestamp}.json', 'w') as f:
                import json
                json.dump(json_data, f)

            # Flash a success message
            flash(f"{operation.capitalize()} task created successfully", "success")

            # Redirect to the home page
            return redirect(url_for('index'))

    return render_template('form.html', form=form, operation=operation)


if __name__ == '__main__':
    app.run(debug=True)
