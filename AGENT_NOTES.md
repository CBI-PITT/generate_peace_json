# Agent Notes

- 2026-06-12: Updated Flask `AGENTS.md` to require reading root and Flask notes before changes and appending Flask notes after subproject file changes.
- 2026-06-15: Updated `form.html`, `form_image_calculator.html`, and `create_workflow.html` to remember the last selected browser folder within the current form page and reopen subsequent pickers there.
- 2026-06-15: Added Flask reader plugin `ome_zarr_reader_plugin.py` so `.ome.zarr` readers can be submitted with `channel` and `resolution_level` like `omehans_reader`.
- 2026-06-15: Added config-based feature flags so disabling `flask_file_browser` also disables auth, hides browser/login UI, skips browser/auth route setup, and renders operation/workflow path fields as plain text inputs.
- 2026-06-15: Fixed auth-disabled runtime paths by making queue view read-only without auth, blocking `/cancel` when auth is off, and using the home-directory username or `anonymous` for workflow/template and operation ownership fallback.
