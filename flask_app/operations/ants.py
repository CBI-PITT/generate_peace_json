from wtforms import Form, StringField, FieldList, FormField, HiddenField, RadioField, IntegerField, SelectField

from .base import BaseOperation
from forms import BaseForm
from utils.registration import get_names_from_url, TripleSelectSubForm


class AntsForm(BaseForm):
    names = get_names_from_url()
    operation = HiddenField('Operation', default='ants')
    atlas = SelectField(
        'Atlas',
        choices=[(x, x) for x in names],
        default='allen_mouse_25um'
    )
    orientation = FormField(TripleSelectSubForm, label='Orientation (Origin)')


class Ants(BaseOperation):
    name = "ants"
    category = "registration"
    description = "Register brain to an atlas"

    def get_form(self):
        return AntsForm

    def get_template(self):
        return "form_autofill_output.html"

    def _update_fields(self, data):
        new_data = {}
        for k, v in data.items():
            if k == "orientation":
                v = v["select1"][0] + v["select2"][0] + v["select3"][0]
            new_data[k] = v
        return new_data

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
