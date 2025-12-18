from .base import BaseOperation
from forms import ResNetClassificationForm
from utils.fs import get_input_from_data, get_output_from_data
from utils.users import get_user


class ResNetClassification(BaseOperation):
    name = "resnet_classification"
    category = "post_processing"
    description = "Classify puncta to true cells or artifacts using a binary ResNet-50 deep learning classifier"

    def get_form(self):
        return ResNetClassificationForm

    def get_username(self):
        return get_user(self.form.cell_candidates_path.data)

    def _update_fields(self, json_data):
        if json_data["input"] == "":
            json_data["input"] = get_input_from_data(json_data["extras"]["cell_candidates_path"])
        if json_data["output"] == "":
            json_data["output"] = get_output_from_data(json_data["input"])
        return json_data
