from .base import BaseOperation
from forms import DeleteBGDetectionsForm
from utils.users import get_user


class DeleteBGDetections(BaseOperation):
    name = "delete_background_detections"
    category = "post_processing"
    description = '''
    Delete detected points (noise) that are in the background.
    Requires path to detected spots (detected with deepblink / cellfinder / other)
    and path to background/foreground masks (segmented with ilastik / other)
    '''

    def get_form(self):
        return DeleteBGDetectionsForm

    def get_username(self):
        return get_user(self.form.cell_candidates_path.data)
