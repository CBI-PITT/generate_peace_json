from .base import BaseOperation
from forms import CombineWithMetadataForm


class CombineWithMetadata(BaseOperation):
    name = "combine_with_metadata"
    description = "Add columns describing your data (such as treatment, sex, time point) into the cells csv"

    def get_form(self):
        return CombineWithMetadataForm

    def get_template(self):
        return "metadata.html"

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
    #     with open(f'/h20/CBI/Iana/json/test/SLURM_settings_{timestamp}.json', 'w') as f:
    #         import json
    #         json.dump(json_data, f)
