from wtforms import StringField, SubmitField, Form, BooleanField, HiddenField, IntegerField
from wtforms.validators import DataRequired
from operations import BaseReader
from forms import BaseForm


class ImarisReaderForm(BaseForm):
    operation = HiddenField('Operation', validators=[DataRequired()], default='imaris_reader_crop')
    channel = IntegerField('Channel (number, starting with 0)', default='0')
    resolution_level = IntegerField('Resolution level (number, starting with 0)', default='0')
    z_start = IntegerField("Z start value", default='0')
    z_end = IntegerField("Z end value", default='-1')
    y_start = IntegerField("Y start value", default='0')
    y_end = IntegerField("Y end value", default='-1')
    x_start = IntegerField("X start value", default='0')
    x_end = IntegerField("X end value", default='-1')


class ImarisReaderCropPlugin(BaseReader):
    name = "imaris_reader_crop"
    description = "Read a piece of .ims Imaris file into a tiff series."

    def get_form(self):
        return ImarisReaderForm

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
    #     with open(f'/h20/CBI/Iana/json/SLURM_reader_{timestamp}.json', 'w') as f:
    #         import json
    #         json.dump(json_data, f)
