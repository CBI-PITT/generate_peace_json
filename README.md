# PEACE web application (Flask)

A Flask web GUI that generates JSON task files for the PEACE pipeline. Users
compose single-operation tasks and multi-step workflows through forms backed by
an embedded file browser; a back-end daemon (`../peace_pipe_line_slurm_test/`)
watches the task folder and executes everything on a SLURM cluster.

## The PEACE system

```
                       researcher (web browser)
                              │
                              ▼
              ┌───────────────────────────────┐
              │        Flask web app          │
              │  (generate_peace_json_test)   │
              └───────┬───────────────┬───────┘
              writes  │               │ mounts
                      ▼               ▼
         ┌──────────────────┐  ┌────────────────────────┐
         │ JSON task files  │  │     file browser       │
         │ (shared folder)  │  │ (flask_file_browser_   │
         └────────┬─────────┘  │ test) + Add-to-        │
                  │ polls      │ dashboard button       │
                  ▼            └───────────┬────────────┘
    ┌──────────────────────┐              │
    │  back-end daemon     │              ▼
    │  (peace_pipe_line_   │   ┌───────────────────────┐
    │  slurm_test)         │   │    data dashboard     │
    └──────────┬───────────┘   │    (data_dashboard)   │
               │ sbatch        └───────────▲───────────┘
               ▼                           │ results
    ┌──────────────────────┐               │
    │    SLURM cluster     │──── outputs ──┘
    │  (job arrays, GPUs)  │
    └──────────────────────┘
```

| Repository | Role |
|---|---|
| **`generate_peace_json_test` (this repo)** | Flask web app that generates task JSON |
| `../peace_pipe_line_slurm_test/` | Back-end daemon that runs the tasks |
| `../flask_file_browser_test/` | File-browser blueprint mounted under `/browser` |
| `../data_dashboard/` | Dashboard blueprint mounted under `/dashboard` |

## Features

- **Operation catalog** — searchable, grouped by category (readers,
  pre-processing, cell detection, segmentation, registration, post-processing,
  metadata); one dynamically generated form per operation.
- **Embedded file browser** — every path field opens a modal browser over the
  configured browsable roots; selections return via `postMessage`; output
  folders are autofilled from the input's provenance file.
- **Workflow builder** — add operation forms as steps, bind each step's inputs
  to the named outputs of earlier steps, save/load/delete per-user templates.
- **Job history** — *My jobs* / *My workflows* with live status from
  `squeue`/`sacct`; cancel, hold, release and re-run per record; workflows can
  be re-run from any step (fork-from-step, which rebuilds downstream steps from
  recorded history).
- **Live queue page** — current SLURM queue with state badges; cancel is
  ownership-checked.
- **Authentication** — institutional LDAP/NTLM login, rate-limited; a special
  admin role can manage any user's records.

## Architecture

```
flask_app/
├── app.py            entry point: routes, plugin discovery, blueprint mounts
├── config.py         env-driven configuration (JSON folder, port, history)
├── auth.py           Flask-Login + LDAP/NTLM authentication
├── forms.py          WTForms classes, one per operation
├── operations/       UI operation plugins (BaseOperation / BaseReader)
├── workflows/        workflow payload generation (steps, input bindings)
├── templates/        pages: catalog, forms, workflow builder, history, queue
├── static/           browser picker JS, styles
├── utils/            job history, SLURM status/queue parsing, registration
└── saved_workflows/  per-user workflow templates
```

Operation plugins are discovered at start-up: each defines `name`, `category`,
`description`, a `get_form()` WTForms class, a `get_template()` page, and
`process_data(form)` which collects field data and writes the submission JSON.
Readers subclass `BaseReader` and write `SLURM_reader*` payloads; operations
write `SLURM_settings*` payloads; the workflow builder writes
`SLURM_workflow*` payloads.

### Route map

| Route | Purpose |
|---|---|
| `/` | Home: action cards, My jobs / My workflows |
| `/operations`, `/analyze/<category>`, `/read` | Operations catalog |
| `/operation/<name>` GET/POST | Single-operation form → JSON |
| `/workflow/new` GET/POST | Workflow builder → JSON |
| `/workflow/templates*` | Per-user workflow template CRUD |
| `/queue` | Live SLURM queue |
| `/cancel`, `/history/.../{cancel,hold,release,rerun}` | Job control (ownership-checked) |
| `/get_output_dir` | Output autofill from `.dataset_info.json` |
| `/browser/...` | Mounted file browser blueprint |
| `/dashboard/...` | Mounted data dashboard blueprint |

## JSON contract

The web app writes task files with four top-level keys — `input`, `output`,
`operation`, `extras` — into the folder the backend watches. Example:

```json
{
    "input": "/data/iyer-s/RSCM/brain1_mag8x_montage.ims",
    "output": "/data/iyer-s/analysis/brain1/tiffs/",
    "operation": "spotiflow",
    "extras": {"user": "iyer-s", "priority": "2", "signal_channel": 1,
               "resolution_level": 1, "model": "general"}
}
```

The field names inside `extras` must match the `kwargs.get(...)` names the
backend operation reads — treat the contract as a compatibility boundary (see
`../peace_pipe_line_slurm_test/README.md`).

## Install and run

```bash
# from the repo root
python3 -m pip install -r requirements.txt

# run
cd flask_app
python3 app.py
# → http://localhost:1515
```

The install includes the package itself and `../data_dashboard` as editable
dependencies, plus `duckdb` for the dashboard's default backend.

### Configuration (env vars and `flask_app/config.py`)

| Variable | Default | Meaning |
|---|---|---|
| `PEACE_JSON_FOLDER` | (see `flask_app/config.py`) | watched folder submissions are written to (must match the backend's `JSON_FOLDERS`) |
| `PEACE_FLASK_PORT` | `1515` | bind port |
| `PEACE_JOB_HISTORY_DIR` | `<JSON_FOLDER>/history` | durable job/workflow records |
| `PEACE_SECRET_KEY` | random per boot | Flask secret key (set it in production) |

Browser/dashboard behaviour (browsable roots, LDAP domain, BrAinPI links,
dashboard flag) is configured in the file browser package's
`settings.ini` — see `../flask_file_browser_test/README.md`.

## Adding an operation

1. Add a WTForms class in `flask_app/forms.py` (CapWords, ends with `Form`;
   inherit `BaseForm`/`PreProcessingForm` as appropriate).
2. Add a plugin in `flask_app/operations/<name>.py` (CapWords class, subclass
   `BaseOperation`; set `name` to the backend operation identifier, pick a
   `category`).
3. Reuse the generic form template (`form_autofill_output.html` when output
   derives from the first input) unless the UX needs a custom layout.
4. Add the matching backend operation package — see "Adding an operation" in
   `../peace_pipe_line_slurm_test/README.md`.
5. Verify: `python3 -m py_compile flask_app/app.py flask_app/forms.py flask_app/operations/*.py`,
   then submit the form and inspect the generated JSON.

## Tests

```bash
python3 -m pytest
```

Eight test modules (~60 tests) cover the catalog routes, home history,
workflow logic (z-range validation, orientation/metadata packing, template
round-trips), history routes and permissions, queue utilities, the
browse-picker contracts, and the dashboard blueprint glue. All writes are
sandboxed to temporary `PEACE_JSON_FOLDER`/`PEACE_JOB_HISTORY_DIR` directories
before the app is imported; login is mocked via the session and
`squeue`/`sacct`/`scancel` are mocked, so the suite runs without SLURM.

## Security notes

Job control endpoints verify ownership through the scheduler and fail closed;
login is rate-limited. Two deployment caveats to fix before exposing the app
beyond a trusted network: CSRF is currently disabled
(`WTF_CSRF_ENABLED = False`) and debug mode is on — set a real
`PEACE_SECRET_KEY`, disable debug, and put the app behind TLS.
