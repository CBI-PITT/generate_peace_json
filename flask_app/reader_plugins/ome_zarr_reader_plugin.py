from wtforms import HiddenField, IntegerField
from wtforms.validators import DataRequired

from operations import BaseReader
from forms import BaseForm


class OMEZarrReaderForm(BaseForm):
    operation = HiddenField('Operation', validators=[DataRequired()], default='ome_zarr_reader')
    channel = IntegerField('Channel (number, starting with 0)', default='0', render_kw={'data-workflow-editable': 'true', 'data-workflow-field-type': 'number'})
    resolution_level = IntegerField('Resolution level (number, starting with 0)', default='0', render_kw={'data-workflow-editable': 'true', 'data-workflow-field-type': 'number'})


class OMEZarrReaderPlugin(BaseReader):
    name = 'ome_zarr_reader'
    description = 'Read multiscale .ome.zarr data into a tiff series using the top-level scale arrays.'

    def get_form(self):
        return OMEZarrReaderForm
