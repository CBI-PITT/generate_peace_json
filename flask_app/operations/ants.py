from wtforms import Form, StringField, FieldList, FormField, HiddenField, RadioField, IntegerField, SelectField

from .base import BaseOperation
from forms import BaseForm
from utils.registration import bg_atlas_names, TripleSelectSubForm


class AntsForm(BaseForm):
    names = bg_atlas_names.atlas_names
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

    def _update_fields(self, json_data):
        extras = json_data["extras"]
        new_data = {}
        for k, v in extras.items():
            if k == "orientation":
                v = v["select1"][0] + v["select2"][0] + v["select3"][0]
            new_data[k] = v
        json_data["extras"] = new_data
        return json_data
