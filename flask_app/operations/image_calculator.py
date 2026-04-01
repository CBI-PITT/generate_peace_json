from .base import BaseOperation
from forms import ImageCalculatorForm


class ImageCalculator(BaseOperation):
    name = "image_calculator"
    category = "pre_processing"
    description = "Apply folder-wise image math or logic to matching TIFF pairs"

    def get_form(self):
        return ImageCalculatorForm

    def get_template(self):
        return "form_autofill_output.html"
