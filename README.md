# Muft Captions

Caption editor for bilingual (English / Urdu) short-form video. Upload a clip,
get word-level captions, style them with a template, and export an MP4 with the
captions burned in.

## Running it

### On GitHub, with no local setup

Open the repository on GitHub, press **`.`**-adjacent **Code → Codespaces → Create
codespace**. The devcontainer installs FFmpeg and the dependencies, creates two
sample projects, and forwards port 3000. Then:

```bash
npm start
```

The password gate is off in a Codespace, since the URL is already private to you.
Everything except generating new captions works without credentials — the editor,
all 37 templates, the timeline, and MP4 export all run on the sample projects.

### Locally

```bash
npm install
npm start         # http://localhost:3000
```

FFmpeg and FFprobe must be on the `PATH` — they do all the video work: transcode,
waveform, filmstrip, thumbnails, and the final burn-in.

The caption fonts are committed, so there is nothing to download on a first run.
`npm run fonts` only exists to regenerate them, and that needs `python3` with
`fonttools` — most Google Fonts now ship as variable fonts and have to be
instanced down to static weights. See [Fonts](#fonts) for why that matters.

Starting without a `.env` works: the editor and export are fully usable, and the
server says plainly that transcription and composition are not configured.

```bash
npm run fixtures   # sample projects, if you want something to open
```

## Configuration

Everything has a working default, so the app runs with no configuration. Set any
of these as environment variables to override.

Credentials live in a **`.env` file** in the project root, which is gitignored and
loaded automatically at startup. Copy `.env.example` to `.env` and fill it in.

They used to be literals in `server.js`, which meant every rotation was a code
edit and a commit, and the values were readable by anyone with repository access.

```bash
cp .env.example .env
# fill it in, then:
npm run credentials:check
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `ACCESS_PASSWORD` | `muftcaptions2026` | The shared password for the team |
| `REQUIRE_PASSWORD` | `true` | Set to `false` to remove the password gate entirely. Only do this when the app is not reachable from the internet. |
| `SONIOX_API_KEY` | *(required)* | Speech-to-text key |
| `GEMINI_API_BASE` | Google's API | Point at a Gemini-compatible proxy instead — see below |
| `GEMINI_API_KEY` | *(unset)* | Key for whichever backend `GEMINI_API_BASE` names |
| `GEMINI_API_MODEL` | `gemini-3.5-flash` | Model used for caption composition |
| `GEMINI_COOKIES` | *(unset)* | Fallback: a Cookie header from a signed-in gemini.google.com tab |
| `GEMINI_SAPISID` | read from cookies | Only needed if the cookie string lacks SAPISID |

`npm run credentials:check` verifies each of these against the live services and
tells you what to fix. Run it whenever captions get worse for no obvious reason —
an expired Google session degrades output silently rather than failing.

## Caption composition

Grouping words into lines, choosing which word to emphasise, and converting Urdu
script to Roman Urdu are all done by Gemini. A long transcript is composed in
pieces of about 140 words, broken at speech pauses, because one request for the
whole clip comes back truncated and then looks like a parse error. A piece that
fails is grouped by pauses on its own; the rest keep their proper composition.
Configure one of the two backends below — they take the same request shape, so
the app supports either.

Run `npm run gemini:doctor` at any time to see what is actually configured, which
models the backend offers, and how they compare on a real caption prompt.

### Option 1: AIStudioToAPI (no paid key)

[AIStudioToAPI](https://github.com/iBUHub/AIStudioToAPI) drives a logged-in Google
AI Studio session in a real browser and exposes Gemini-compatible endpoints. It
needs no paid API key. Its default port is `7860`.

```bash
GEMINI_API_BASE=http://localhost:7860/v1beta
GEMINI_API_KEY=your-api-key-1     # one of the API_KEYS you configured in it
```

Because it drives a web UI rather than the real API, it may not honour newer
request options. The client detects that and retries with a simpler request
rather than failing, so structured output and thinking controls degrade quietly
instead of breaking composition.

The set of models available through AI Studio differs from the public API — ask
your instance with `npm run gemini:doctor`.

### Option 2: Google's API

Get a key from [Google AI Studio](https://aistudio.google.com/apikey), set
`GEMINI_API_KEY`, and leave `GEMINI_API_BASE` unset.

### Option 3: a gemini.google.com session

Free and needs no setup beyond pasting a Cookie header into `GEMINI_COOKIES`, but
it is not a supported interface and the session expires on its own after a few
weeks. When it does, composition does not error — it quietly degrades: lines are
grouped by pauses alone, the emphasised word becomes simply the longest word in
the line, and non-Latin script stays unconverted. The editor warns when this
happens and the server says so at startup.

Two things make this less fragile than the original implementation. The session is
read from the environment rather than hardcoded, so refreshing it is not a code
change. And the `bl` build identifier is discovered from the live page instead of
being pinned — the pinned value in the original code was from 2026-05-25 and had
drifted almost three months behind the deployed build.

If you already have a working browser session and want to use it with
AIStudioToAPI rather than here, `npm run cookies:to-aistudio` converts a Cookie
header into the `configs/auth/auth-1.json` file that project stores. Google may
still challenge a session presented from a different machine, in which case use
its supported `npm run setup-auth` flow.

### Choosing a model

| Model | Notes |
| --- | --- |
| `gemini-3.5-flash` | **Default.** Full Flash intelligence, available to at least 2027-05-19. |
| `gemini-3.5-flash-lite` | Cheapest, longest guarantee (2027-07-21). Google positions Flash-Lite for translation and simple data processing, which is close to this task — worth comparing before paying for Flash. |
| `gemini-3.7-flash` | Newest Flash, but flagged *short-term availability*: it can be retired about 45 days after a replacement ships. Only pick it if someone will keep this setting current. |
| `gemini-3-flash-preview` | Has a free tier on Google's API, so useful for trying this without enabling billing. |
| `gemini-3.1-pro-preview` | Far more capable than this task needs, several times the price, no free tier. Only if emphasis choices look poor on Flash. |

`gemini-2.0-flash` and the rest of the 2.0 line **were retired on 2026-06-01** and
now return 404. The client refuses them up front with an explanation rather than
letting the request fail obscurely.

Two Gemini 3 behaviours the client handles for you: temperature is left at its
default, because Google advises against lowering it on Gemini 3 (it can cause
looping and degraded output), and thinking is pinned to `low`, because Gemini 3
otherwise defaults to `high` and spends latency and tokens reasoning about a task
that does not need it.

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
| `src/gemini.js` | Gemini client and the model catalogue |
| `src/languages.js` | Transcription languages |
| `src/maintenance.js` | Disk usage reporting and cleanup |
| `src/caption-utils.js` | Transcript normalisation, prompts, subtitle formats |
| `src/composition-engine.js` | Grouping words into compositions |
| `src/compose-chunks.js` | Splits a long transcript so composition survives length |
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
- **hero** — one chosen word renders large with the words spoken before it on a
  line above and those after it below. Hero-mode extras: `heroSizeScale`,
  `heroSupportSizeScale`, `heroCasing` (so the hero can shout in caps while the
  support text stays as spoken), `heroSupportAlign` and `heroGapEm`.

`layout.reveal` decides whether the whole phrase arrives at once (`all`) or words
appear as they are spoken (`progressive`). Positions are laid out for the finished
line either way, so a revealing word appears in place rather than pushing the
words already on screen around.

### Emphasis pacing

A hero template only emphasises lines the composer marked `emphasis` or
`spotlight`; a `plain` line renders entirely in the base style with nothing
picked out. That distinction is what stops an emphasis style feeling relentless —
the quiet lines are what give the loud ones their impact.

How often emphasis fires is enforced in `src/composition-engine.js` rather than
left to the composer. `enforceEmphasisBudget` budgets against the length of the
clip, not a share of lines, because fast speech is cut into far more lines and a
percentage target quietly becomes a flood. It scores candidates from the hero word
itself and the speaker's delivery, keeps the strongest that fit, and refuses to
spend the budget on a filler word. `enforceLineBreaks` splits any line that runs
across a pause or overruns the word limit.

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
npm test                 # syntax, catalogue, styling, reference match, reveal, chunks, Gemini
npm run test:all         # everything, including the browser tests

npm run test:templates   # every template draws real ink, in frame, at 4 aspect ratios,
                         # and survives phrases long enough to test auto-shrink
npm run test:styles      # a line, and a single word inside it, can be restyled alone
npm run test:reference   # Muft Glow measured against the reference clip, phrase by phrase
npm run test:reveal      # word-by-word templates reveal in place without reflowing
npm run test:chunks      # a long transcript still composes when a single request would truncate
npm run test:gemini      # Gemini client against a stand-in backend: routing, auth,
                         # structured output, retry-on-rejection, retired models
npm run test:ui          # headless browser: preview renders, controls work, no leaks
npm run test:wysiwyg     # the preview and the export agree on layout
npm run test:export      # queue a real render and verify captions are in the pixels
npm run preview:templates  # contact sheet of the catalogue as a PNG
```

Two checks report on real projects rather than fixtures, so they are diagnostics
rather than part of `npm test`:

```bash
npm run check:emphasis   # how often a project emphasises a word, against the reference
npm run check:breaks     # whether lines end at pauses and stay readable
npm run recompose -- projects/<id>.json          # re-compose an existing transcript
npm run recompose -- projects/<id>.json --write  # and save the result
```

`recompose` is the way to try a prompt change against real speech without
spending a transcription, and the way to bring a project composed under older
pacing rules up to date. It uses the same chunked path the server does, so a
long project is a valid test of both the prompt and the length handling.

### Matching a reference style

`npm run test:reference` exists because "does this look right?" is not something
two people can settle by looking. The figures it checks were taken by scanning
every frame of a reference clip, isolating the emphasised word by colour, and
measuring its ink: cap height as a share of frame height, colour at the glyph
core, the size ratio between emphasised and supporting text, alignment, and where
the block sits. The script renders the same phrases with our template and
measures them the same way.

It also records what could not be matched. The reference moves its caption block
by up to 5% of frame height between lines — rock steady while a line is on screen,
and not predicted by anything in the line's own structure, which looks like it is
keeping clear of the speaker. A fixed anchor cannot reproduce that, so the
vertical tolerance is set to the reference's own spread rather than to a precision
that does not exist.

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
