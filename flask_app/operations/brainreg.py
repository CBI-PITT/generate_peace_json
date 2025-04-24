import requests

from wtforms import StringField, FieldList, FormField, HiddenField, RadioField, IntegerField, SelectField

from .base import BaseOperation
from forms import BaseForm


def get_names_from_url(url):
    try:
        response = requests.get(url, timeout=2)
        response.raise_for_status()  # Raise error for bad status codes
        lines = response.text.splitlines()
        names = []

        for line in lines[1:]:  # Skip the first line
            if '=' in line:
                name = line.split('=', 1)[0].strip()
                names.append(name)
        return names

    except (requests.Timeout, requests.RequestException):
        # Return empty list on timeout or any other request failure
        return ['allen_mouse_25um']

url = "https://gin.g-node.org/brainglobe/atlases/raw/master/last_versions.conf"
names = get_names_from_url(url)


class BrainRegForm(BaseForm):
    operation = HiddenField('Operation', default='brainreg')
    atlas = SelectField(
        'Atlas',
        choices=[(x, x) for x in names],
        default='allen_mouse_25um'
    )
    orientation = StringField('Orientation (three-letter string)', default='sal')
    brain_geometry = SelectField(
        'Brain Geometry',
        choices=[('full', 'full'), ('hemisphere_l', 'hemisphere_l'), ('hemisphere_r', 'hemisphere_r')],
        default='full'
    )


class BrainReg(BaseOperation):
    name = "brainreg"
    category = "registration"
    description = "Register stack representing a 3D brain volume to an atlas from brainglobe atlas API"

    def get_form(self):
        return BrainRegForm

    def get_template(self):
        return "form_autofill_output.html"

    # def process_data(self, form):
    #     # Example processing logic for filter operation
    #     json_data = {
    #         "input": form.input.data,
    #         "output": form.output.data,
    #         "operation": self.name,
    #         "extras": {}
    #     }
    #     data = {field.name: field.data for field in form if field.name not in ["submit", "csrf_token", "input", "output", "operation"]}
    #     json_data["extras"] = data
    #     # Save the JSON data to a file
    #     from datetime import datetime
    #     timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    #     with open(f'/h20/CBI/Iana/json/SLURM_settings_{timestamp}.json', 'w') as f:
    #         import json
    #         json.dump(json_data, f)
