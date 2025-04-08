from .base import BaseOperation
from forms import TransformPointsForm


class TransformPoints(BaseOperation):
    name = "transform_points"
    category = "post_processing"
    description = "Map detected cells to corresponding atlas parcellations based on existing registration"

    def get_form(self):
        return TransformPointsForm
