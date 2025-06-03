from .base import BaseOperation
from forms import RemoveStripesFFTForm


class RemoveStripesFFT(BaseOperation):
    name = "remove_stripes_fft"
    category = "pre_processing"
    description = "Remove stripes (mainly for RSCM images)"

    def get_form(self):
        return RemoveStripesFFTForm

    def get_template(self):
        return "form_autofill_output.html"
