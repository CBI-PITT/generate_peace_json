from .base import BaseOperation
from forms import TransformPointsForm
from utils.users import get_user


class TransformPoints(BaseOperation):
    name = "transform_points"
    category = "post_processing"
    description = "Map detected cells to corresponding atlas parcellations based on existing registration"

    def get_form(self):
        return TransformPointsForm

    def get_username(self):
        return get_user(self.form.cells_path.data)
