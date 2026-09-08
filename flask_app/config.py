import os


def _env_flag(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in ('1', 'true', 'yes', 'on')


JSON_FOLDER = os.environ.get('PEACE_JSON_FOLDER', "/h20/CBI/Iana/json/test")
PORT = int(os.environ.get('PEACE_FLASK_PORT', '1212'))
ENABLE_JOB_HISTORY = True # _env_flag('PEACE_ENABLE_JOB_HISTORY', default=False)
USE_SACCT_FOR_HISTORY = True # _env_flag('PEACE_USE_SACCT_FOR_HISTORY', default=True)
JOB_HISTORY_DIR = os.environ.get('PEACE_JOB_HISTORY_DIR', os.path.join(JSON_FOLDER, 'history'))
