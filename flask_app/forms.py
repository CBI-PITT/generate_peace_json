from flask_wtf import FlaskForm
from wtforms import Form, StringField, FieldList, FloatField, FormField, BooleanField, HiddenField, RadioField, IntegerField, SelectField
from wtforms.validators import DataRequired


class BaseForm(FlaskForm):
    input = StringField('Input Location', validators=[DataRequired()])
    output = StringField('Output Location', validators=[DataRequired()])
    priority = RadioField('Priority (0=lowest 5=highest)', default='2', choices=[(str(i), str(i)) for i in range(6)])


class DeepBlinkForm(BaseForm):
    operation = HiddenField('Operation', validators=[DataRequired()], default='deepblink')
    with_dbscan = BooleanField('With DBSCAN?')


# class BrainRegForm(BaseForm):
#     operation = HiddenField('Operation', validators=[DataRequired()], default='brainreg')
#     atlas = StringField('Atlas (atlas name from Brainglobe Atlas API)', default='allen_mouse_25um')
#     orientation = StringField('Orientation (three-letter string)', default='sal')
#     brain_geometry = SelectField(
#         'Brain Geometry',
#         choices=[('full', 'full'), ('hemisphere_l', 'hemisphere_l'), ('hemisphere_r', 'hemisphere_r')],
#         default='full'
#     )


class CellFinderForm(BaseForm):
    operation = HiddenField('Operation', validators=[DataRequired()], default='cellfinder')


# class AntsForm(BaseForm):
#     operation = HiddenField('Operation', validators=[DataRequired()], default='ants')
#     atlas = StringField('Atlas (atlas name from Brainglobe Atlas API)', default='allen_mouse_25um')
#     orientation = StringField('Orientation (three-letter string)', default='sal')


class ContrastStretchForm(BaseForm):
    operation = HiddenField('Operation', validators=[DataRequired()], default='stretch_contrast')
    percentile_low = FloatField('Lower Percentile', default='1.0')
    percentile_high = FloatField('Higher Percentile', default='99.0')


class IlastikForm(BaseForm):
    operation = HiddenField('Operation', validators=[DataRequired()], default='ilastik')
    model_path = StringField('Model path', validators=[DataRequired()])
    binarize_threshold = FloatField("Threshold for binarization", default=0.5)


class DBSCANForm(BaseForm):
    input = HiddenField()
    output = HiddenField()
    operation = HiddenField('Operation', validators=[DataRequired()], default='dbscan')
    cell_candidates_path = StringField('Detected cells path', validators=[DataRequired()])
    epsilon = IntegerField('Maximum Distance in Cluster', validators=[DataRequired()], default=3)
    min_samples = IntegerField('Minimum Number of Samples in Cluster', validators=[DataRequired()], default=2)


class CellposeForm(BaseForm):
    operation = HiddenField('Operation', validators=[DataRequired()], default='cellpose')
    model = StringField('Model name (general, nuclei, cyto, cyto2 etc)', validators=[DataRequired()], default='general')


class ResNetClassificationForm(BaseForm):
    input = HiddenField()
    output = HiddenField()
    operation = HiddenField('Operation', validators=[DataRequired()], default='resnet_classification')
    cell_candidates_path = StringField('Detected cells path', validators=[DataRequired()])
    model_path = StringField('Model path', validators=[DataRequired()])


class Unet3DForm(BaseForm):
    operation = HiddenField('Operation', validators=[DataRequired()], default='unet_3d')
    model = StringField('Model path', validators=[DataRequired()])


class DeleteBGDetectionsForm(BaseForm):
    input = HiddenField()
    output = HiddenField()
    operation = HiddenField('Operation', validators=[DataRequired()], default='delete_background_detections')
    cell_candidates_path = StringField('Detected cells path', validators=[DataRequired()])
    fg_mask_path = StringField('Foreground mask path', validators=[DataRequired()])


class TransformPointsForm(BaseForm):
    input = HiddenField()
    output = HiddenField()
    operation = HiddenField('Operation', validators=[DataRequired()], default='transform_points')
    cells_path = StringField('Detected cells path', validators=[DataRequired()])
    registration_path = StringField('Path to registration folder', validators=[DataRequired()])


class MetaFieldForm(Form):
    key = StringField('Key', validators=[DataRequired()])
    value = StringField('Value', validators=[DataRequired()])


class CombineWithMetadataForm(BaseForm):
    input = HiddenField()
    output = HiddenField()
    operation = HiddenField('Operation', validators=[DataRequired()], default='combine_with_metadata')
    cells_path = StringField('Cells CSV path', validators=[DataRequired()])
    metadata = FieldList(FormField(MetaFieldForm), min_entries=1)


class DenoiseCellposeForm(BaseForm):
    operation = HiddenField('Operation', validators=[DataRequired()], default='denoise_cellpose')
    model = SelectField('Model name',
        choices=[
            ('denoise_cyto3', 'denoise_cyto3'),
            ('deblur_cyto3', 'deblur_cyto3'),
            ('denoise_cyto2', 'denoise_cyto2'),
            ('deblur_cyto2', 'deblur_cyto2'),
            ('denoise_nuclei', 'denoise_nuclei'),
            ('deblur_nuclei', 'deblur_nuclei')
        ],
        default='denoise_cyto3'
    )
    diameter = IntegerField('Diameter', default=100)


class RemoveStripesFFTForm(BaseForm):
    operation = HiddenField('Operation', validators=[DataRequired()], default='remove_stripes_fft')
    stripe_direction = SelectField("Stripes orientation", choices=[('v', 'vertical'), ('h', 'horizontal')], default='v')
    composites_dir = StringField("Composites directory (RSCM only)")
