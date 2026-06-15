import json
import os

from wtforms import FloatField, HiddenField
from wtforms.validators import DataRequired
from operations import BaseReader
from forms import BaseForm
from config import JSON_FOLDER


class TiffSeriesReaderForm(BaseForm):
    output = HiddenField()
    operation = HiddenField('Operation', validators=[DataRequired()], default='tiff_series_reader')
    resolution_z = FloatField('Z resolution, microns', default=1, render_kw={'data-workflow-editable': 'true', 'data-workflow-field-type': 'number'})
    resolution_y = FloatField('Y resolution, microns', default=1, render_kw={'data-workflow-editable': 'true', 'data-workflow-field-type': 'number'})
    resolution_x = FloatField('X resolution, microns', default=1, render_kw={'data-workflow-editable': 'true', 'data-workflow-field-type': 'number'})


class TiffSeriesReaderPlugin(BaseReader):
    name = "tiff_series_reader"
    description = "Make existing tiff series compatible with the analysis tools"

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
        json_file_path = os.path.join(JSON_FOLDER, f'SLURM_reader_{timestamp}.json')
        with open(json_file_path, 'w') as f:
            json.dump(json_data, f)
        os.chmod(json_file_path, 0o664)
