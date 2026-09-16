from .base import BaseOperation
from forms import NearestNeighborForm
from utils.users import get_user


class NearestNeighbor(BaseOperation):
    name = "nearest_neighbor"
    category = "post_processing"
    description = "Compute the distance to the nearest neighboring point in microns (3D) for each point; transform_points-style CSVs also get a per-region mean/median summary"

    def get_form(self):
        return NearestNeighborForm

    def get_username(self):
        return get_user(self.form.cells_path.data)
