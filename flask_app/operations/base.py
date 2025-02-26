import json
import os
from datetime import datetime


class BaseOperation:
    name = "Base"
    description = "Description will be added"

    def get_form(self):
        """
        Returns a WTForms form class for this operation.
        Each plugin must override this method.
        """
        raise NotImplementedError("Plugins must implement the 'get_form' method.")

    def process_data(self, form):
        # Example processing logic for filter operation
        json_data = {
            "input": form.input.data,
            "output": form.output.data,
            "operation": self.name,
            "extras": {}
        }
        data = {field.name: field.data for field in form if field.name not in ["submit", "csrf_token", "input", "output", "operation"]}
        json_data["extras"] = data
        # Save the JSON data to a file
        from datetime import datetime
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        json_file_path = f'/h20/CBI/Iana/json/SLURM_settings_{timestamp}.json'
        with open(json_file_path, 'w') as f:
            json.dump(json_data, f)
        os.chmod(json_file_path, 0o664)


class BaseReader:
    name = "Base"
    description = "Description will be added"

    def get_form(self):
        """
        Returns a WTForms form class for this operation.
        Each plugin must override this method.
        """
        raise NotImplementedError("Plugins must implement the 'get_form' method.")

    def process_data(self, form):
        # Example processing logic for filter operation
        json_data = {
            "input": form.input.data,
            "output": form.output.data,
            "operation": self.name,
            "extras": {}
        }
        data = {field.name: field.data for field in form if field.name not in ["submit", "csrf_token", "input", "output", "operation"]}
        json_data["extras"] = data
        # Save the JSON data to a file
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        json_file_path = f'/h20/CBI/Iana/json/SLURM_reader_{timestamp}.json'
        with open(json_file_path, 'w') as f:
            json.dump(json_data, f)
        os.chmod(json_file_path, 0o664)
