from .base import BaseOperation
from forms import GaussianBlurForm


class GaussianBlur(BaseOperation):
    name = "gaussian_blur"
    category = "pre_processing"
    description = "Apply Gaussian blur to smooth the image"

    def get_form(self):
        return GaussianBlurForm

    def get_template(self):
        return "form_autofill_output.html"
