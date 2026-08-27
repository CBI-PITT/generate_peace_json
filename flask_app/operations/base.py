from flask_login import current_user

from utils.job_history import new_job_submission_payload, write_submission_json
from utils.users import get_user


class BaseOperation:
    name = "Base"
    category = "other"
    description = "Description will be added"

    def get_form(self):
        """
        Returns a WTForms form class for this operation.
        Each plugin must override this method.
        """
        raise NotImplementedError("Plugins must implement the 'get_form' method.")

    def get_template(self):
        return 'form.html'

    def get_username(self):
        return get_user(self.form.input.data)

    def process_data(self, form):
        self.form = form
        data = {field.name: field.data for field in form if field.name not in ["submit", "csrf_token", "input", "output", "operation"]}
        submitted_by = current_user.get_id() or 'anonymous'
        job_user = current_user.get_id()
        if job_user == "CBI_Admin":
            job_user = self.get_username()
        if job_user:
            data['user'] = job_user

        data = self._update_fields(data)
        json_data, file_name = new_job_submission_payload(
            form.input.data,
            form.output.data,
            self.name,
            data,
            submitted_by,
            prefix='SLURM_settings'
        )
        write_submission_json(file_name, json_data)

    def _update_fields(self, data):
        """
        To be overriden by subclasses. Adds custom logic for processing unusual form fields.
        """
        return data


class BaseReader:
    name = "Base"
    description = "Description will be added"
    category = "reader"

    def get_form(self):
        """
        Returns a WTForms form class for this operation.
        Each plugin must override this method.
        """
        raise NotImplementedError("Plugins must implement the 'get_form' method.")

    def get_template(self):
        return 'form.html'

    def process_data(self, form):
        data = {field.name: field.data for field in form if field.name not in ["submit", "csrf_token", "input", "output", "operation"]}
        submitted_by = current_user.get_id() or 'anonymous'
        job_user = current_user.get_id()
        if job_user == "CBI_Admin" or not job_user:
            job_user = get_user(form.input.data)
        if job_user:
            data['user'] = job_user
        json_data, file_name = new_job_submission_payload(
            form.input.data,
            form.output.data,
            self.name,
            data,
            submitted_by,
            prefix='SLURM_reader'
        )
        write_submission_json(file_name, json_data)
