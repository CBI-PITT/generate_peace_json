from .base import BaseOperation
from forms import SpotiflowForm


class Spotiflow(BaseOperation):
    name = "spotiflow"
    category = "cell_detection"
    description = '''
    Detect spots (puncta / cells / nuclei) in a 3D image stack using deep learning method
    '''

    def get_form(self):
        return SpotiflowForm

    def get_template(self):
        return "form_autofill_output.html"
