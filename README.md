# Hexpane

An account-free, offline-first Chrome new tab page.

Built on top of the iHomepage extension, with every dependency on its remote API
and telemetry removed. All GraphQL traffic is answered locally by
`local/shim.js`; data lives in `chrome.storage.local`. **Zero outbound requests
on startup.**

## Install

`chrome://extensions` → enable Developer mode → **Load unpacked** → select this
folder.

An unpacked extension's ID is derived from its folder path, so moving the folder
changes the ID and orphans the existing `chrome.storage.local` data. Pick a
permanent location before you load it.

## How it works

The extension is a prebuilt bundle. Rather than patching the minified app,
`local/shim.js` is loaded as a classic script *before* the bundle and installs
two hooks:

1. Writes a placeholder access token, so the app follows its signed-in code path
   and queries `viewer { ... }` instead of the guest-only `default*` fields.
2. Overrides `window.fetch`. Every GraphQL operation touching `viewer` (plus the
   auth mutations, `newVersion` and `defaultUserWallpaper`) is executed locally
   against a small store; anything else — wallpaper catalogue, weather, search
   suggestions — is forwarded upstream **without auth headers**.

To do that, the shim contains a compact GraphQL implementation: lexer, parser,
printer, executor, fragment and directive handling, and resolvers backed by a
JSON store. Telemetry hosts are blocked outright rather than merely disabled, so
a call from a code path that was missed still goes nowhere.

## Layout

| Path | Purpose |
|---|---|
| `local/shim.js` | GraphQL parser + executor, local resolvers, `window.fetch` override |
| `local/schema.json` | Trimmed introspection schema and canonical selections |
| `local/seed.example.json` | Default layout used when no personal seed is present |
| `local/img-default/` | Icons and wallpaper for the default layout |
| `local/ui.css` | Interface adjustments (bottom-left dock, trimmed menus) |
| `local/backup.js` | Export/import row injected into the settings panel |
| `.orig-backup/` | Untouched originals of every modified file |

Your own layout lives in `local/seed.json` and `local/img/`, both gitignored.
When they are absent the shim falls back to the example seed.

## Backup

Settings has a **Yedekleme** row with export and import buttons. Export downloads
the whole store as a single JSON file; import restores one and reloads.

The file format is shared with any external mirror:

```json
{ "app": "hexpane-extension", "format": 1, "exportedAt": "...",
  "storage": { "ihp:local:v1": { ... } } }
```

`window.__ihpLocal.restore()` accepts either that wrapper or a bare store
object, so a file produced elsewhere can be imported here and vice versa.
Anything else is rejected without touching the existing data.

## Development

`SEED_VERSION` in `local/shim.js` guards the store. A store stamped with an
older number is rebuilt from the seed on next load, so **bump it whenever the
seed changes** — otherwise existing installs keep their old data.

Debug hooks, available in the new tab's console:

| Call | Result |
|---|---|
| `localStorage['ihp:debug'] = '1'` | Per-operation console trace after reload |
| `window.__ihpLocal.trace()` | Last 200 operations: local vs forwarded, status |
| `window.__ihpLocal.dump()` | The entire local store |
| `window.__ihpLocal.restore(payload)` | Restore from a backup, then reload |
| `window.__ihpLocal.reset()` | Rebuild from the seed |

Chrome 137+ dropped `--load-extension`, so automated testing needs
[Chrome for Testing](https://developer.chrome.com/blog/chrome-for-testing):

```bash
npx --yes @puppeteer/browsers install chrome@stable --path ./browsers
```

## Still online by design

Nothing is requested at startup. These only reach the network when you open the
corresponding panel, and they are forwarded anonymously: wallpaper catalogue,
widgets, icon search, weather, and search suggestions.
