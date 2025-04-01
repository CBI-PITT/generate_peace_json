from flask_wtf import FlaskForm
from wtforms import StringField, SubmitField, FieldList, FormField, BooleanField
from wtforms.validators import DataRequired


class BaseForm(FlaskForm):
    input = StringField('Input Location', validators=[DataRequired()])
    output = StringField('Output Location', validators=[DataRequired()])
    priority = StringField('Priority (0=lowest 5=highest)', default='2')


class DeepBlinkForm(BaseForm):
    operation = StringField('Operation', validators=[DataRequired()], default='deepblink', render_kw={"disabled": True})
    with_dbscan = BooleanField('With DBSCAN?')
    # signal_channel = StringField('Signal channel (number, starting with 0)', default='0')
    # resolution_level = StringField('Resolution level (number, starting with 0)', default='0')


class BrainRegForm(BaseForm):
    operation = StringField('Operation', validators=[DataRequired()], default='brainreg', render_kw={"disabled": True})
    # background_channel = StringField('Background channel (number, starting with 0)', default='0')
    atlas = StringField('Atlas (atlas name from Brainglobe Atlas API)', default='allen_mouse_25um')
    orientation = StringField('Orientation (three-letter string)', default='sal')
    brain_geometry = StringField('Brain Geometry (full / hemisphere_l / hemisphere_r)', default='full')


class CellFinderForm(BaseForm):
    operation = StringField('Operation', validators=[DataRequired()], default='cellfinder', render_kw={"disabled": True})
    # signal_channel = StringField('Signal channel (number, starting with 0)', default='0')
    # resolution_level = StringField('Resolution level (number, starting with 0)', default='0')


class AntsForm(BaseForm):
    operation = StringField('Operation', validators=[DataRequired()], default='ants', render_kw={"disabled": True})
    # background_channel = StringField('Background channel (number, starting with 0)', default='0')
    atlas = StringField('Atlas (atlas name from Brainglobe Atlas API)', default='allen_mouse_25um')
    orientation = StringField('Orientation (three-letter string)', default='sal')


class ContrastStretchForm(BaseForm):
    operation = StringField('Operation', validators=[DataRequired()], default='stretch_contrast', render_kw={"disabled": True})
    # channel = StringField('Channel (number, starting with 0)', default='0')
    # resolution_level = StringField('Resolution level (number, starting with 0)', default='0')


class IlastikForm(BaseForm):
    operation = StringField('Operation', validators=[DataRequired()], default='ilastik', render_kw={"disabled": True})
    # channel = StringField('Channel (number, starting with 0)', default='0')
    # resolution_level = StringField('Resolution level (number, starting with 0)', default='0')
    model_path = StringField('Model path', validators=[DataRequired()])


class DBSCANForm(BaseForm):
    operation = StringField('Operation', validators=[DataRequired()], default='dbscan', render_kw={"disabled": True})
    cell_candidates_path = StringField('Detected cells path', validators=[DataRequired()])
    epsilon = StringField('Maximum Distance in Cluster', validators=[DataRequired()], default=3)
    min_samples = StringField('Minimum Number of Samples in Cluster', validators=[DataRequired()], default=2)


class CellposeForm(BaseForm):
    operation = StringField('Operation', validators=[DataRequired()], default='cellpose', render_kw={"disabled": True})
    model = StringField('Model name (general, nuclei, cyto, cyto2 etc)', validators=[DataRequired()], default='general')


class ResNetClassificationForm(BaseForm):
    operation = StringField('Operation', validators=[DataRequired()], default='resnet_classification', render_kw={"disabled": True})
    cell_candidates_path = StringField('Detected cells path', validators=[DataRequired()])
    model_path = StringField('Model path', validators=[DataRequired()])


class Unet3DForm(BaseForm):
    operation = StringField('Operation', validators=[DataRequired()], default='unet_3d', render_kw={"disabled": True})
    model = StringField('Model path', validators=[DataRequired()])


class DeleteBGDetectionsForm(BaseForm):
    operation = StringField('Operation', validators=[DataRequired()], default='delete_background_detections', render_kw={"disabled": True})
    cell_candidates_path = StringField('Detected cells path', validators=[DataRequired()])
    fg_mask_path = StringField('Foreground mask path', validators=[DataRequired()])


class TransformPointsForm(BaseForm):
    operation = StringField('Operation', validators=[DataRequired()], default='transform_points', render_kw={"disabled": True})
    cells_path = StringField('Detected cells path', validators=[DataRequired()])
    registration_path = StringField('Path to registration folder', validators=[DataRequired()])
