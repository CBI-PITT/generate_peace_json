from .base import BaseOperation
from forms import AdaptiveHistogramEqualizationForm


class AdaptiveHistogramEqualization(BaseOperation):
    name = "adaptive_histogram_equalization"
    category = "pre_processing"
    description = "Apply adaptive histogram equalization to improve local contrast"

    def get_form(self):
        return AdaptiveHistogramEqualizationForm

    def get_template(self):
        return "form_autofill_output.html"
