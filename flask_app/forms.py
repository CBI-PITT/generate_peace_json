from flask_wtf import FlaskForm
from wtforms import StringField, SubmitField, FieldList, FormField
from wtforms.validators import DataRequired


class BaseForm(FlaskForm):
    input = StringField('Input Location', validators=[DataRequired()])
    output = StringField('Output Location', validators=[DataRequired()])
    # submit = SubmitField('Submit')


class DeepBlinkForm(BaseForm):
    operation = StringField('Operation', validators=[DataRequired()], default='deepblink', render_kw={"disabled": True})
    signal_channel = StringField('Signal channel (number, starting with 0)', default='0')
    resolution_level = StringField('Resolution level (number, starting with 0)', default='0')


class BrainRegForm(BaseForm):
    operation = StringField('Operation', validators=[DataRequired()], default='brainreg', render_kw={"disabled": True})
    background_channel = StringField('Background channel (number, starting with 0)', default='0')
    atlas = StringField('Atlas (atlas name from Brainglobe Atlas API)', default='allen_mouse_25um')
    orientation = StringField('Orientation (three-letter string)', default='sal')
    brain_geometry = StringField('Brain Geometry (full / hemisphere_l / hemisphere_r)', default='full')


class CellFinderForm(BaseForm):
    operation = StringField('Operation', validators=[DataRequired()], default='cellfinder', render_kw={"disabled": True})
    signal_channel = StringField('Signal channel (number, starting with 0)', default='0')
    resolution_level = StringField('Resolution level (number, starting with 0)', default='0')


class AntsForm(BaseForm):
    operation = StringField('Operation', validators=[DataRequired()], default='ants', render_kw={"disabled": True})
    background_channel = StringField('Background channel (number, starting with 0)', default='0')
    atlas = StringField('Atlas (atlas name from Brainglobe Atlas API)', default='allen_mouse_25um')
    orientation = StringField('Orientation (three-letter string)', default='sal')


class ContrastStretchForm(BaseForm):
    operation = StringField('Operation', validators=[DataRequired()], default='stretch_contrast', render_kw={"disabled": True})
    channel = StringField('Channel (number, starting with 0)', default='0')
    resolution_level = StringField('Resolution level (number, starting with 0)', default='0')
