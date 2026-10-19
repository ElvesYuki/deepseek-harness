---
kind: upgrade-guide
description: The independent desktop launcher replaces staged version switching with in-place maintenance without automatic update backups.
---

# Desktop launcher maintenance

English | [中文](guide.zh.md)

## Change

The independent launcher in `desktop-launcher/` updates its active program directory in place. Updates stop the service and no longer create program or user-data backups. The separate prepare-and-switch action is replaced by Update and start, Repair current version, and Restore bundled version. The default update channel is Stable rather than including previews. Data import retains its separate backup behavior.

Existing active directories remain selected. Prepared versions and historical backups remain on disk but are not activated by the new update controls. Interrupted maintenance blocks startup until repair or restoration succeeds. Restoration replaces program files only; it cannot reverse data migrations performed by a newer DSH version.

Fresh packaged installations require runtime deployment before ordinary startup. On macOS, run the installation command in the DMG; Windows Setup performs deployment before completion. Existing active runtimes are retained. See the [installation instructions](../../../../desktop-launcher/README.md).

## Migration

1. Finish any active tasks before updating the launcher. Keep user configuration and project files outside its managed program directory: maintenance resets source and removes generated or untracked program files.
2. Choose Stable, Preview, or Main in the update panel. A missing stable release is reported rather than replaced with a preview.
3. For an interrupted update, choose Repair or Retry maintenance. For offline program recovery, choose Restore bundled version. Neither operation restores or deletes user data; if an older program cannot read existing data, use a compatible newer version.
4. Confirm the management window reports the intended version and commit and opens the workspace. Retain existing data and historical backups when diagnosing a failure. See the [launcher maintenance reference](../../../../desktop-launcher/README.md).
