class BaseOperation:
    name = "Base"

    def get_form(self):
        """
        Returns a WTForms form class for this operation.
        Each plugin must override this method.
        """
        raise NotImplementedError("Plugins must implement the 'get_form' method.")

    def process_data(self, form_data):
        """
        Processes form data submitted for this operation.
        """
        raise NotImplementedError("Plugins must implement the 'process_data' method.")
