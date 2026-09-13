# Live source presets

JSON files in this folder appear as **mini-screens** in the editor's **+ Live**
dialog. They are not a bin tab and are never dropped onto the timeline.

Each `.json` is one MediaMTX recording path (or an array of them):

```json
{ "name": "Camera 1", "path": "cam1", "list": "http://localhost:9996/list" }
```

| Field    | Default                         | Notes |
| -------- | ------------------------------- | ----- |
| `name`   | file stem                       | Label under the screen |
| `path`   | file stem                       | MediaMTX `path=` (or a full `/list?path=` URL) |
| `list`   | `http://localhost:9996/list`    | `/list` origin |
| `poster` | `<stem>.svg` / `.jpg` / `.png`  | Still shown while the feed is offline |
| `order`  | 1000                            | Sort key (lower first) |

An optional poster image next to the JSON (same stem) fills the screen when
`/list` cannot be reached. Drop new JSON files in — the open dialog refreshes.
