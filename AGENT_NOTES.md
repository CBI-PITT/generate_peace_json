# Agent Notes

- 2026-06-12: Updated Flask `AGENTS.md` to require reading root and Flask notes before changes and appending Flask notes after subproject file changes.
- 2026-06-15: Updated `form.html`, `form_image_calculator.html`, and `create_workflow.html` to remember the last selected browser folder within the current form page and reopen subsequent pickers there.
- 2026-06-15: Added Flask reader plugin `ome_zarr_reader_plugin.py` so `.ome.zarr` readers can be submitted with `channel` and `resolution_level` like `omehans_reader`.
- 2026-08-27: Updated workflow-template rendering so numeric Flask form fields stay editable after template save/load, and float values like stretch-contrast percentiles keep their decimal values.
- 2026-08-27: Fixed workflow JSON generation so non-reader steps backfill missing `extras.output` from the input folder's `.dataset_info.json` `base_output_dir` when available.
- 2026-08-27: Added optional Flask job/workflow history support behind `PEACE_ENABLE_JOB_HISTORY`, including submission IDs, history JSON records, Home-page `My jobs` / `My workflows` sections, SLURM-backed status display, and cancel/hold/release/rerun endpoints with workflow rerun-from-step fork support.
- 2026-08-27: Fixed Flask history ownership so `submitted_by` stays the logged-in account, while `extras.user` still uses the path-derived execution user for `CBI_Admin` submissions and preserves existing SLURM job-name prefixes.
- 2026-09-02: Added preprocessing-only `z_start` and `z_end` integer fields with `0`/`-1` defaults, direct-form and workflow validation, image-calculator rendering, and legacy saved-workflow compatibility for all nine preprocessing operations.
- 2026-09-08: Restored standalone operation output-folder autofill after browser input selection, with stale-request and manual-output safeguards; workflow fragments, calculator handlers, and server-side workflow output derivation remain unchanged.
