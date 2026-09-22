from .base import BaseOperation
from forms import RemoveBackgroundForm


class RemoveBackground(BaseOperation):
    name = "remove_background"
    category = "pre_processing"
    description = "Remove image background with SAM2 (one GPU job per z-layer); saves the background-removed image and the brain mask"

    def get_form(self):
        return RemoveBackgroundForm

    def get_template(self):
        return "form_autofill_output.html"
