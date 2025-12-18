from .base import BaseOperation
from forms import DeleteBGDetectionsForm
from utils.fs import get_input_from_data, get_output_from_data
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

    def _update_fields(self, json_data):
        if json_data["input"] == "":
            json_data["input"] = get_input_from_data(json_data["extras"]["cell_candidates_path"])
        if json_data["output"] == "":
            json_data["output"] = get_output_from_data(json_data["input"])
        return json_data
