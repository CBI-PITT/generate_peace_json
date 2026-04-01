from .base import BaseOperation
from forms import GammaCorrectionForm


class GammaCorrection(BaseOperation):
    name = "gamma_correction"
    category = "pre_processing"
    description = "Apply gamma correction to adjust image intensity"

    def get_form(self):
        return GammaCorrectionForm

    def get_template(self):
        return "form_autofill_output.html"
