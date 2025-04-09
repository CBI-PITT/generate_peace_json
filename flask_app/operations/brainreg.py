from .base import BaseOperation
from forms import BrainRegForm


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
