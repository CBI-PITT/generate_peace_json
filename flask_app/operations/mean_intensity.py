from .base import BaseOperation
from forms import MeanIntensityForm
from utils.users import get_user


class MeanIntensity(BaseOperation):
    name = "mean_intensity"
    category = "post_processing"
    description = "Compute mean intensity in a sphere around each detected cell position using the raw image resolved from provenance"

    def get_form(self):
        return MeanIntensityForm

    def get_username(self):
        return get_user(self.form.cells_path.data)
