from flask import Flask, render_template, request, jsonify, redirect, url_for
from forms import BaseForm, DeepBlinkForm, BrainRegForm
from flask import flash

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your_secret_key'

# Operation forms dictionary
OPERATION_FORMS = {
    "deepblink": DeepBlinkForm,
    "brainreg": BrainRegForm
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
        data = {field.name: field.data for field in form if field.name not in ["submit", "csrf_token"]}
        # Save the JSON data to a file
        with open('/h20/CBI/Iana/json/operation_data.json', 'w') as f:
            import json
            json.dump(data, f)

        # Flash a success message
        flash(f"{operation.capitalize()} task created successfully", "success")

        # Redirect to the home page
        return redirect(url_for('index'))

    return render_template('form.html', form=form, operation=operation)


if __name__ == '__main__':
    app.run(debug=True)
