from .base import BaseOperation
from forms import DenoiseCellposeForm


class DenoiseCellpose(BaseOperation):
    name = "denoise_cellpose"
    category = "pre_processing"
    description = "Denoise image using available image restoration models from cellpose"

    def get_form(self):
        return DenoiseCellposeForm

    def get_template(self):
        return "form_autofill_output.html"
