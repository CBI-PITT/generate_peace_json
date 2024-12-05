from wtforms import Form


class BasePlugin:
    name = "BasePlugin"

    def get_form(self):
        """
        Returns a WTForms form class for this plugin.
        Each plugin must override this method.
        """
        raise NotImplementedError("Plugins must implement the 'get_form' method.")

    def process_data(self, form_data):
        """
        Processes form data submitted for this plugin.
        """
        raise NotImplementedError("Plugins must implement the 'process_data' method.")
