from .base import BaseOperation
from forms import TransformPointsForm
from utils.fs import get_input_from_data, get_output_from_data
from utils.users import get_user


class TransformPoints(BaseOperation):
    name = "transform_points"
    category = "post_processing"
    description = "Map detected cells to corresponding atlas parcellations based on existing registration"

    def get_form(self):
        return TransformPointsForm

    def get_username(self):
        return get_user(self.form.cells_path.data)

    def _update_fields(self, json_data):
        if json_data["input"] == "":
            json_data["input"] = get_input_from_data(json_data["extras"]["cells_path"])
        if json_data["output"] == "":
            json_data["output"] = get_output_from_data(json_data["input"])
        return json_data
