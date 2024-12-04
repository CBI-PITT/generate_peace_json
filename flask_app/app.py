from flask import Flask, render_template, request, jsonify, redirect, url_for
from forms import BaseForm, DeepBlinkForm, BrainRegForm, CellFinderForm, AntsForm, ContrastStretchForm
from flask import flash

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


@app.route('/')
def index():
    return render_template('index.html', operations=OPERATION_FORMS.keys())


@app.route('/operation/<operation>', methods=['GET', 'POST'])
def operation_form(operation):
    if operation not in OPERATION_FORMS:
        return f"Operation '{operation}' not supported", 404

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
