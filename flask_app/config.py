import os
from pathlib import Path


JSON_FOLDER = str(Path.home() / "json")


def env_flag(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {'1', 'true', 'yes', 'on'}


ENABLE_FILE_BROWSER = env_flag('ENABLE_FILE_BROWSER', default=True)
ENABLE_AUTH = ENABLE_FILE_BROWSER and env_flag('ENABLE_AUTH', default=True)
APP_NAME = os.environ.get('PEACE_APP_NAME', 'PEACE')
GA4_GTAG = os.environ.get('PEACE_GA4_GTAG', '')
AUTH_LOGIN_LIMIT = os.environ.get('PEACE_AUTH_LOGIN_LIMIT', '5 per minute')
AUTH_BYPASS = env_flag('PEACE_AUTH_BYPASS', default=True)
AUTH_DOMAIN_SERVER = os.environ.get('PEACE_AUTH_DOMAIN_SERVER', 'cbilab.pitt.edu')
AUTH_DOMAIN_PORT = os.environ.get('PEACE_AUTH_DOMAIN_PORT', '389')
AUTH_DOMAIN_NAME = os.environ.get('PEACE_AUTH_DOMAIN_NAME', 'cbilab')
SECRET_KEY = os.environ.get('PEACE_SECRET_KEY', 'your_secret_key')
