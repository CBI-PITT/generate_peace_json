from .base import BaseOperation
from forms import ResNetClassificationForm
from utils.users import get_user


class ResNetClassification(BaseOperation):
    name = "resnet_classification"
    category = "post_processing"
    description = "Classify puncta to true cells or artifacts using a binary ResNet-50 deep learning classifier"

    def get_form(self):
        return ResNetClassificationForm

    def get_username(self):
        return get_user(self.form.cell_candidates_path.data)

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
