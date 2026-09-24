# @vbcdx/dsh-config-editor-plugin

A DeepSeek Harness (DSH) composition plugin that provides an in-app browser
window for viewing and editing configuration files (`settings.yaml`,
`.credentials.yaml`, `reverse-proxy.json`) and agent preset compositions
(`agent.cordis.yml`) — and survives restarts, because it is installed into
the profile composition instead of being a per-session dynamic plugin.

## Background

When running DSH on a headless server or container (e.g. Proxmox/LXC),
clicking "Open configuration file" invokes the host's desktop opener
(`xdg-open`), which fails because there is no desktop environment. This
plugin gives those files an in-app editor instead.

## Features

- **In-app modal** — floats above the interface (`shell.overlay`), toggled
  from a "Config Editor" button in the conversation header utilities row
- **Config & preset browser** — inspect and edit:
  - Global settings (`$DSH_HOME/settings.yaml`)
  - Credentials metadata (`$DSH_HOME/.credentials.yaml`)
  - Reverse proxy / remote access config (`$DSH_HOME/reverse-proxy.json`)
  - Agent presets (`$DSH_HOME/.agent-presets/<id>/agent.cordis.yml`)
- **Backup on save** — a uniquely-named, exclusively-created `.bak.<ms>` copy is
  written next to the file before every change (the file itself is only
  overwritten after the backup succeeds). Saves that share a millisecond get
  distinct `.bak.<ms>-<n>` names, so an earlier recovery point is never
  overwritten
- **Target containment** — every document target is proven to be a regular file
  under `$DSH_HOME` with no symlink in any path component before it is listed,
  read, backed up, or written, so an allowed ID cannot be redirected outside the
  home through an existing symlink
- **No desktop opener** — nothing touches `xdg-open`

## Install

From git (the supported install command):

```sh
dsh plugin --profile <profile> add git+https://<your-git-host>/<org>/dsh-config-editor-plugin.git
```

or from a local checkout:

```sh
dsh plugin --profile <profile> add /path/to/this/repo
```

`dsh plugin add` installs the package and, because the package declares
`dsh.bundle`, appends it to the profile's layer stack automatically. Then
restart the harness; the composition loads at boot.

From npm (once published):

```sh
dsh plugin --profile <profile> add @vbcdx/dsh-config-editor-plugin
```

## Configuration

See [.env.example](.env.example). The only variable is the optional
`DSH_HOME` (default `~/.dsh`) — the state directory the editor reads and
writes. No real credentials are stored in this repository.

## Architecture

- **`lib/index.js` (host half)** — a real composition plugin row; serves one
  route, `/plugins/config-editor`:
  - `GET` → `{ docs }`, the editable document list
  - `GET ?id=<id>` → `{ content }`, one file's content
  - `POST {id, content}` → `{ success, backup }`, save with backup

  The client addresses documents by **ID, never by path**; IDs map only to
  the fixed well-known files and discovered preset `agent.cordis.yml` files,
  so the route cannot be pointed at arbitrary paths. Saves are capped at
  5 MB.

- **`lib/client.js` (browser half)** — a `window.__ModuleLoader__.load`
  bundle found through the `dsh.client` field in `package.json`; registers
  the header trigger and the overlay editor, and fetches the host route
  with plain same-origin `fetch`.

- **`cordis.patch.yml`** — the composition patch inserting the plugin row,
  declared through `dsh.bundle` so `dsh plugin add` recognizes the package
  as a profile layer.

## Notes

- No syntax validation happens before saving; the timestamped backup is
  the recovery path for a bad edit.
- The dynamic-plugin predecessor (removed in this version) routed file
  access through the shell service with base64-encoded writes; as a real
  host plugin this package reads and writes files directly with `node:fs`.

## License

MIT
