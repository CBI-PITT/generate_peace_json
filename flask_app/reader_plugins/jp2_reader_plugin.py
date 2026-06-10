from wtforms import FloatField, HiddenField
from wtforms.validators import DataRequired

from operations import BaseReader
from forms import BaseForm


class JP2ReaderForm(BaseForm):
    operation = HiddenField('Operation', validators=[DataRequired()], default='jp2_reader')
    resolution_z = FloatField(
        'Z resolution, microns',
        default=1,
        render_kw={'data-workflow-editable': 'true', 'data-workflow-field-type': 'number'}
    )
    resolution_y = FloatField(
        'Y resolution, microns',
        default=1,
        render_kw={'data-workflow-editable': 'true', 'data-workflow-field-type': 'number'}
    )
    resolution_x = FloatField(
        'X resolution, microns',
        default=1,
        render_kw={'data-workflow-editable': 'true', 'data-workflow-field-type': 'number'}
    )


class JP2ReaderPlugin(BaseReader):
    name = 'jp2_reader'
    description = 'Read a folder of grayscale or RGB .jp2 slice files into split-channel tif series and RGB composites.'

    def get_form(self):
        return JP2ReaderForm
