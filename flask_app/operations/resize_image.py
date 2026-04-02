from .base import BaseOperation
from forms import ResizeImageForm


class ResizeImage(BaseOperation):
    name = "resize_image"
    category = "pre_processing"
    description = "Resize each TIFF image by a uniform x/y scale factor"

    def get_form(self):
        return ResizeImageForm

    def get_template(self):
        return "form_autofill_output.html"
