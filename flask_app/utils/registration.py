import requests

from wtforms import Form, SelectField


def get_names_from_url():
    url = "https://gin.g-node.org/brainglobe/atlases/raw/master/last_versions.conf"

    try:
        response = requests.get(url, timeout=2)
        response.raise_for_status()  # Raise error for bad status codes
        lines = response.text.splitlines()
        names = []

        for line in lines[1:]:  # Skip the first line
            if '=' in line:
                name = line.split('=', 1)[0].strip()
                names.append(name)
        return names

    except (requests.Timeout, requests.RequestException):
        # Return empty list on timeout or any other request failure
        return ['allen_mouse_25um']


ORIENTATION_CHOICES = [
    ('anterior', 'anterior'),
    ('posterior', 'posterior'),
    ('inferior', 'inferior'),
    ('superior', 'superior'),
    ('left', 'left'),
    ('right', 'right')
]


class TripleSelectSubForm(Form):
    select1 = SelectField(choices=ORIENTATION_CHOICES, default='superior')
    select2 = SelectField(choices=ORIENTATION_CHOICES, default='anterior')
    select3 = SelectField(choices=ORIENTATION_CHOICES, default='left')

