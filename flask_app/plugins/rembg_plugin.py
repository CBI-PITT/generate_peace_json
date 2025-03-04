from wtforms import StringField, SubmitField, Form
from wtforms.validators import DataRequired
from operations import BaseOperation
from forms import BaseForm


class RembgForm(BaseForm):
    operation = StringField('Operation', validators=[DataRequired()], default='rembg', render_kw={"disabled": True})
    # channel = StringField('Channel (number, starting with 0)', default='0')
    # resolution_level = StringField('Resolution level (number, starting with 0)', default='0')


class RembgPlugin(BaseOperation):
    name = "rembg"
    description = "Remove image background using a neural net"

    def get_form(self):
        return RembgForm

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

