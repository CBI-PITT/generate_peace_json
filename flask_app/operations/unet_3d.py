from .base import BaseOperation
from forms import Unet3DForm


class Unet3D(BaseOperation):
    name = "unet_3d"
    category = "segmentation"
    description = "Semantic segmentation of a 3D image stack using a provided model"

    def get_form(self):
        return Unet3DForm

    def get_template(self):
        return "form_autofill_output.html"
