import os


def _env_flag(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in ('1', 'true', 'yes', 'on')


JSON_FOLDER = os.environ.get('PEACE_JSON_FOLDER', "/h20/CBI/Iana/json/test")
PORT = int(os.environ.get('PEACE_FLASK_PORT', '1515'))
ENABLE_JOB_HISTORY = True # _env_flag('PEACE_ENABLE_JOB_HISTORY', default=False)
USE_SACCT_FOR_HISTORY = True # _env_flag('PEACE_USE_SACCT_FOR_HISTORY', default=True)
JOB_HISTORY_DIR = os.environ.get('PEACE_JOB_HISTORY_DIR', os.path.join(JSON_FOLDER, 'history'))
# The interactive debugger enables code execution from error pages; keep it off
# unless PEACE_FLASK_DEBUG is explicitly set for local development.
DEBUG = _env_flag('PEACE_FLASK_DEBUG', default=False)
ACCESS_LOG = os.environ.get(
    'PEACE_ACCESS_LOG',
    f"/h20/CBI/Iana/logs/peace_flask_access_{PORT}.log"
)
