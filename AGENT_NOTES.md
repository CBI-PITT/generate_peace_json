# Agent Notes

- 2026-06-12: Updated Flask `AGENTS.md` to require reading root and Flask notes before changes and appending Flask notes after subproject file changes.
- 2026-06-15: Updated `form.html`, `form_image_calculator.html`, and `create_workflow.html` to remember the last selected browser folder within the current form page and reopen subsequent pickers there.
- 2026-06-15: Added Flask reader plugin `ome_zarr_reader_plugin.py` so `.ome.zarr` readers can be submitted with `channel` and `resolution_level` like `omehans_reader`.
- 2026-08-27: Updated workflow-template rendering so numeric Flask form fields stay editable after template save/load, and float values like stretch-contrast percentiles keep their decimal values.
- 2026-08-27: Fixed workflow JSON generation so non-reader steps backfill missing `extras.output` from the input folder's `.dataset_info.json` `base_output_dir` when available.
- 2026-08-27: Fixed queue-page job cancellation for compressed SLURM array IDs by stripping `%` throttle suffixes before `scancel`, and moved cancel permission checks into Flask server logic shared with queue rendering.
