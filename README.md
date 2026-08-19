# Muft Captions

Caption editor for bilingual (English / Urdu) short-form video. Upload a clip,
get word-level captions, style them with a template, and export an MP4 with the
captions burned in.

## Running it

```bash
npm install
npm run fonts     # first run only: downloads the caption fonts
npm start         # http://localhost:3000
```

FFmpeg and FFprobe must be on the `PATH` — they do the video work.

`npm run fonts` needs `python3` with `fonttools` (`pip install fonttools`)
because most Google Fonts now ship as variable fonts and have to be instanced
down to static weights. See [Fonts](#fonts) for why.

## Configuration

Everything has a working default, so the app runs with no configuration. Set any
of these as environment variables to override.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `ACCESS_PASSWORD` | `muftcaptions2026` | The shared password for the team |
| `REQUIRE_PASSWORD` | `true` | Set to `false` to remove the password gate entirely. Only do this when the app is not reachable from the internet. |
| `SONIOX_API_KEY` | inline value | Speech-to-text key |
| `GEMINI_API_KEY` | *(unset)* | Strongly recommended — see below |
| `GEMINI_API_MODEL` | `gemini-2.0-flash` | Model used for caption composition |

### Why `GEMINI_API_KEY` matters

Caption composition — deciding how words group into lines, which word to
emphasise, and converting Urdu script to Roman Urdu — is done by Gemini.

Without a key, the app falls back to an unofficial path that authenticates with
Google **session cookies**. Those cookies expire on their own after a few weeks.
When they do, composition fails and the pipeline silently degrades: lines are
grouped by pauses alone, the emphasised word becomes simply the longest word in
the line, and Urdu is left in Urdu script. The editor now shows a warning when
this happens, but the only real fix is a key.

Get one from [Google AI Studio](https://aistudio.google.com/apikey) and set
`GEMINI_API_KEY`. The cookie path stays as a fallback, so nothing breaks either
way.

## How it fits together

```
upload ──► Soniox ──────────► Gemini ─────────► compositions
           word timings       grouping,          (a line of words with
                              emphasis,           one emphasised word)
                              Roman Urdu
                                                        │
                                    ┌───────────────────┴───────────────────┐
                                    ▼                                       ▼
                          editor preview                            MP4 export
                          (browser canvas)                    (canvas ──► FFmpeg)
                                    └──────────► same renderer ◄─────────┘
```

| Path | Role |
| --- | --- |
| `server.js` | HTTP API, transcription and composition pipeline |
| `src/render/caption-renderer.js` | The renderer. Used by both the preview and the export. |
| `src/render/templates.js` | The template catalogue, as data |
| `src/render/fonts.js` | Font registry, shared by browser and server |
| `src/render/custom-fonts.js` | Uploaded fonts: validation and storage |
| `src/render/style-overrides.js` | Applies style tweaks to a template |
| `src/render/exporter.js` | Render jobs: queue, progress, cancellation |
| `src/media/analyze.js` | Waveform and filmstrip generation for the timeline |
| `src/languages.js` | Transcription languages |
| `src/maintenance.js` | Disk usage reporting and cleanup |
| `src/caption-utils.js` | Transcript normalisation, prompts, subtitle formats |
| `src/composition-engine.js` | Grouping words into compositions |
| `public/` | The editor UI (vanilla JS, no build step) |

The preview and the export import the **same** renderer module, rather than
keeping a browser copy in sync by hand. `npm run test:wysiwyg` exists to prove
they still agree.

## Templates

A template is plain data. Adding one means adding an object to
`src/render/templates.js` — no rendering code.

```js
{
  id: 'bold-yellow',
  name: 'Bold Yellow',
  category: 'High retention',
  mode: 'karaoke',                       // or 'hero'
  font: { family: 'Anton', weight: 400, size: 104, casing: 'upper' },
  layout: { x: 0.5, y: 0.72, maxWidthPct: 0.88, maxLines: 2, align: 'center' },
  word:   { fill: { type: 'solid', color: '#FFFFFF' }, stroke: { width: 9, color: '#000' } },
  active: { fill: { type: 'solid', color: '#FFE600' }, pop: { scale: 1.18 } },
  animation: { target: 'word', type: 'pop', durationMs: 240 }
}
```

Two layout modes:

- **karaoke** — the whole phrase is on screen and the word being spoken is
  styled differently. This is how most viral caption styles work.
- **hero** — one chosen word renders large and centred with the surrounding
  words stacked above and below it.

Style blocks (`word`, `active`, and optionally `pending` / `spoken`) accept
`fill` (solid, gradient or depth), `stroke`, `shadow`, `glow`, `background`
(pill, box or marker), `extrude`, `underline`, `blur`, `opacity`, `sizeScale`
and `pop`. A `lineBackground` draws a bar behind a whole line.

Sizes are authored against a 1080×1920 canvas and scale to whatever the output
is. Author generously: a phrase that would overflow its line budget is shrunk
automatically, so a large size just means "as big as this phrase allows".

Sizes scale with the frame's **shorter side**, while horizontal extents follow
its width and the vertical anchor follows its height. That is what makes one
template work at 9:16, 1:1 and 16:9 without editing.

### Styling on top of a template

A project stores a template id plus a flat set of overrides, and a single caption
line can carry its own overrides that layer on top. The **Text** tab's scope
switch chooses which of the two an edit is written to. Overrides are applied by
one shared module, so the editor and the exporter derive the same template from
the same data.

### Custom fonts

Upload a `.ttf` or `.otf` from the Text tab. WOFF and WOFF2 are rejected on
purpose: they load in the browser but not in the export rasteriser, so a caption
would preview in the uploaded font and export in a fallback. Uploads are also
checked by their file header rather than their extension, and refused if they
would shadow a built-in family name.

### Fonts

Each font weight is a separate static file registered under its own alias
(`mc-Inter-800`). This is deliberate:

- `@napi-rs/canvas` cannot select a weight from a variable font — every weight
  renders identically, so a "Black" template would silently export as Regular.
- It also does not reliably pick between several static files that share a
  family name.

Binding one alias to one file takes weight resolution out of the picture, so the
browser and the exporter always land on the same glyphs. `scripts/fetch-fonts.mjs`
instances variable sources into real static weights to make that possible.

## Tests

```bash
npm test                 # syntax, the template catalogue, per-line styling
npm run test:all         # everything, including the browser tests

npm run test:templates   # every template draws real ink, in frame, at 4 aspect ratios
npm run test:styles      # a single line can be styled without affecting the others
npm run test:ui          # headless browser: preview renders, controls work, no leaks
npm run test:wysiwyg     # the preview and the export agree on layout
npm run test:export      # queue a real render and verify captions are in the pixels
npm run preview:templates  # contact sheet of the catalogue as a PNG
```

The UI, WYSIWYG and export tests need a running server. They default to
`http://localhost:3111` and create their own fixtures:

```bash
PORT=3111 npm start
npm run test:all
```

`npm run fixtures` builds the sample video and projects on its own. The browser
test rebuilds them each run, because it edits captions and styles as part of what
it verifies and would otherwise leave the fixtures altered.

The WYSIWYG test is worth keeping honest: it is what caught the preview using a
fallback font (canvas does not trigger `@font-face` loading the way DOM text
does) and glow rendering differently in each engine.

## Housekeeping

The sidebar shows real disk usage for this install. **Free up space** removes
finished exports, uploaded videos no project refers to any more, and stale
timeline caches. Waveforms and filmstrips regenerate on demand, so clearing them
costs only the time to rebuild.

## Known limits

- **Single tenant.** One shared password, and projects are JSON files in
  `projects/` with no per-user separation. Fine for an internal team; a real
  database would be needed for accounts.
- **One render at a time.** Exports are queued deliberately; a render saturates
  CPU and memory.
- **No reframing.** The preview and export follow the source video's aspect
  ratio. Templates adapt to any ratio, but the app will not crop or letterbox a
  landscape video into a vertical frame for you.
- **The editor is desktop-only.** There is no responsive layout for small
  screens.
