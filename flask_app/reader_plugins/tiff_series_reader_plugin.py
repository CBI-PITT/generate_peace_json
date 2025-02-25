import json
import os

from wtforms import StringField, SubmitField, Form, HiddenField
from wtforms.validators import DataRequired
from operations import BaseReader
from forms import BaseForm


class TiffSeriesReaderForm(BaseForm):
    output = HiddenField()
    operation = StringField('Operation', validators=[DataRequired()], default='tiff_series_reader', render_kw={"disabled": True})
    resolution_z = StringField('Z resolution, microns', default='1')
    resolution_y = StringField('Y resolution, microns', default='1')
    resolution_x = StringField('X resolution, microns', default='1')


class TiffSeriesReaderPlugin(BaseReader):
    name = "tiff_series_reader"

    def get_form(self):
        return TiffSeriesReaderForm

    def process_data(self, form):
        # Example processing logic for filter operation
        json_data = {
            "input": form.input.data,
            "output": form.input.data,
            "operation": self.name,
            "extras": {}
        }
        data = {field.name: field.data for field in form if field.name not in ["submit", "csrf_token", "input", "output", "operation"]}
        json_data["extras"] = data
        # Save the JSON data to a file
        from datetime import datetime
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        json_file_path = f'/h20/CBI/Iana/json/SLURM_reader_{timestamp}.json'
        with open(json_file_path, 'w') as f:
            json.dump(json_data, f)
        os.chmod(json_file_path, 0o664)
