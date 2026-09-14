from .base import BaseOperation
from forms import MeanIntensityForm
from utils.users import get_user


class MeanIntensity(BaseOperation):
    name = "mean_intensity"
    category = "post_processing"
    description = "Compute mean intensity in a sphere of a given radius around each detected cell position and append it to the CSV"

    def get_form(self):
        return MeanIntensityForm

    def get_username(self):
        return get_user(self.form.cells_path.data)
