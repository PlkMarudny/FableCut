# FableCut asset library

Default, reusable assets. Most folders show up live in the editor's left
panel tabs and can be dropped onto the timeline — files are referenced in
place (`/library/...`), never copied into the project. `live/` is the exception:
those JSON presets feed the **+ Live** dialog as mini-screens, not a bin tab.

| Folder      | Editor tab | Contents                                                        |
| ----------- | ---------- | --------------------------------------------------------------- |
| `sfx/`      | Sound FX   | whooshes, clicks, risers, impacts… (`.mp3 .wav .ogg .m4a`)       |
| `elements/` | Elements   | overlay art: PNGs with alpha, light leaks, textures, short loops |
| `svg/`      | SVG        | vector animations authored by Claude (see CLAUDE.md conventions) |
| `fonts/`    | (Font editor) | `.ttf .otf .woff .woff2` — auto-registered, family = file name |
| `live/`     | + Live dialog | MediaMTX path presets (`{name, path, list?}` JSON + posters) |

Drop free assets you find online into the matching folder — the open editor
refreshes the list automatically. Subfolders are allowed and listed too.
