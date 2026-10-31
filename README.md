# hermes-gdrive-pane

Google Drive as a pane inside the Hermes Desktop app (Linux/macOS).

## What it does

- Browse the real Drive tree folder by folder with breadcrumbs, plus **Recent**,
  **Shared** and **Starred** views.
- Full-text search (`name contains` / `fullText contains`) over the account.
- File metadata: kind, size, modified, owner, parents, sharing state, link.
- Open in Google Drive, or hand the item to the agent.
- **Ask agent**, routed to the chat in front of you or to a fresh chat in any
  Hermes profile. The handoff carries the file id, MIME type, path and the exact
  `gog-robert drive download` / `drive search` command to use — including the
  "Docs export to PDF, the saved file has no extension" trap that otherwise
  wastes a turn.

Read-only. Nothing is downloaded, moved, renamed, trashed or shared from the
pane; the agent does that with `gog-robert` (or the rclone mount at
`~/GoogleDrive`).

## Install

```bash
hermes plugins install <this-repo-url>
```

Then open **Capabilities → Plugins** in the desktop app (that also re-syncs the
desktop half), switch the plugin on if it is off, and restart the app if the
pane does not appear. `hermes plugins update hermes-gdrive-pane` updates it.

## Credentials

No token ships in this repo. The Python half
(`dashboard/plugin_api.py`) reads `$HERMES_HOME/google_token.json` for the
**active profile** at request time — the same grant the Gmail pane uses. Drive
needs the `drive` scope; a profile without it shows an explicit "not
authorised" panel.

## Notes

- Desktop + Python halves; the renderer reaches its backend through
  `ctx.rest` (`/api/plugins/hermes-gdrive-pane/*`), so the refresh token never
  reaches the renderer.
- Reads only: folder listings (one page of 100), search, one file's metadata.
- Shared-drive items are included (`includeItemsFromAllDrives`).
- `plugins.enabled` in the profile config is the gate that lets the gateway
  import `plugin_api.py`; the in-app toggle is separate.
