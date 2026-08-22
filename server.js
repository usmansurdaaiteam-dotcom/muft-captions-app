import express from 'express';
import multer from 'multer';
import { readFile, writeFile, rm, mkdir, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { SonioxNodeClient } from '@soniox/node';
import './src/load-env.js';
import {
  normalizeSonioxTranscript,
  prepareTokensForV2,
  makeV2CompositionPrompt,
  countUnromanised,
  parseV2CompositionResponse,
  compositionsToSrt,
  compositionsToVtt,
  compositionsToText,
  V2_COMPOSITION_SCHEMA
} from './src/caption-utils.js';
import {
  callGeminiApi,
  verifyGeminiAccess,
  GEMINI_MODELS,
  DEFAULT_GEMINI_MODEL,
  GOOGLE_API_BASE
} from './src/gemini.js';
import { callGeminiWeb, checkGeminiWebAccess } from './src/gemini-web.js';
import { composeInChunks } from './src/compose-chunks.js';
import { getLanguage, listLanguages, validateLanguages, DEFAULT_LANGUAGE_ID } from './src/languages.js';
import { getSupportedLanguages, verifySonioxAccess } from './src/soniox.js';
import {
  buildCompositions,
  recomputeComposition
} from './src/composition-engine.js';
import { registerFonts } from './src/render/fonts-node.js';
import { getTemplate, listTemplates, TEMPLATE_IDS, DEFAULT_TEMPLATE_ID } from './src/render/templates.js';
import { listFamilies, buildFontFaceCss, FONT_FILES } from './src/render/fonts.js';
import { loadCustomFonts, addCustomFont, removeCustomFont } from './src/render/custom-fonts.js';
import { getStorageReport, runCleanup } from './src/maintenance.js';
import { applyStyleOverrides, sanitizeOverrides, sanitizeWordOverrides } from './src/render/style-overrides.js';
import { startExport, getJob, cancelJob, getVideoInfo, checkFfmpeg } from './src/render/exporter.js';
import {
  configureCache as configureMediaCache,
  getWaveform,
  getFilmstrip,
  getPoster
} from './src/media/analyze.js';

// ─── Credentials ────────────────────────────────────────────────────────────────
//
// All read from the environment. A .env file in the project root is loaded above
// if present, so nothing has to be passed on the command line.
//
// These used to be literals in this file, which meant every rotation was a code
// edit and a commit, and the values were readable by anyone with repository
// access. Run `npm run credentials:check` to confirm what is configured and
// whether it still works.
const SONIOX_API_KEY = process.env.SONIOX_API_KEY || '';

/**
 * Preferred path for the caption-composition step.
 *
 * Two supported backends, both speaking the same request shape:
 *
 * - Google's API, with a key from https://aistudio.google.com/apikey
 * - A Gemini-compatible proxy such as AIStudioToAPI, which drives a logged-in
 *   AI Studio session. Point GEMINI_API_BASE at its /v1beta URL (default
 *   http://localhost:7860/v1beta) and set GEMINI_API_KEY to one of its API_KEYS.
 *
 * Either removes the failure mode of the cookie-based web client further down,
 * which depends on Google session cookies that expire on their own after a few
 * weeks. When they do, composition fails and the pipeline falls back to picking
 * the longest word in each phrase with no script conversion.
 */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_API_BASE = process.env.GEMINI_API_BASE || GOOGLE_API_BASE;
const GEMINI_API_MODEL = process.env.GEMINI_API_MODEL || DEFAULT_GEMINI_MODEL;

/**
 * Session for the gemini.google.com fallback. Paste a Cookie header from a
 * logged-in browser into GEMINI_COOKIES; the SAPISID is read out of it, so
 * GEMINI_SAPISID only needs setting if the cookie string somehow lacks it.
 */
const GEMINI_COOKIES = process.env.GEMINI_COOKIES || '';
const GEMINI_SAPISID = process.env.GEMINI_SAPISID || '';

/**
 * Ask Gemini to analyse captions.
 *
 * Prefers the configured API (Google's, or a Gemini-compatible proxy such as
 * AIStudioToAPI) and falls back to the gemini.google.com session so an existing
 * deployment keeps working while a backend is being set up.
 *
 * @param {string} prompt
 * @param {object|null} schema optional response schema for structured output
 */
async function callGemini(prompt, schema = null) {
  if (GEMINI_API_KEY) {
    try {
      const result = await callGeminiApi(prompt, {
        apiKey: GEMINI_API_KEY,
        model: GEMINI_API_MODEL,
        base: GEMINI_API_BASE,
        schema
      });
      return result.text;
    } catch (err) {
      console.warn(`[gemini] API call failed (${err.message}); falling back to the web session.`);
    }
  }
  return callGeminiWeb(prompt, { cookies: GEMINI_COOKIES, sapisid: GEMINI_SAPISID });
}

// ─── Server Setup ───────────────────────────────────────────────────────────────

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure uploads & projects dirs exist
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PROJECTS_DIR = path.join(__dirname, 'projects');
const CACHE_DIR = path.join(__dirname, 'cache');
await mkdir(UPLOADS_DIR, { recursive: true }).catch(() => {});
await mkdir(PROJECTS_DIR, { recursive: true }).catch(() => {});
await mkdir(CACHE_DIR, { recursive: true }).catch(() => {});
configureMediaCache(CACHE_DIR);

const app = express();

// Store uploaded files with unique names, keeping original extension
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 700 }
});

// Fonts are held in memory so they can be validated before anything is written.
const fontUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 12 }
});

registerFonts();
await loadCustomFonts();

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Caption fonts, loaded by the browser preview via @font-face using the same
// files and aliases the export renderer registers.
app.use('/assets/fonts', express.static(path.join(__dirname, 'assets', 'fonts'), {
  maxAge: '30d',
  immutable: true
}));
// The renderer modules themselves, so the preview runs the exact same code as
// the export instead of a hand-synced copy.
app.use('/renderer', express.static(path.join(__dirname, 'src', 'render'), {
  setHeaders: (res) => res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
}));

// @font-face declarations generated from the same registry the exporter uses,
// so a font name in a template resolves to the same file in both places.
app.get('/caption-fonts.css', (req, res) => {
  res.type('text/css').send(buildFontFaceCss('/assets/fonts'));
});

// ─── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_TERMS = [
  'CapCut', 'Gemini', 'ChatGPT', 'Google Flow', 'Flow', 'Nano Banana',
  'Kling', 'Veo', 'Sora', 'Runway', 'Midjourney', 'Daffy Studio',
  'MUFT AI', 'Rasta', 'contact sheet', 'moodboard', 'prompt', 'AI campaign'
];

function parseCsv(value = '') {
  return String(value).split(',').map(x => x.trim()).filter(Boolean);
}

/** Bumped when the saved project shape changes, so old files can be migrated. */
const PROJECT_VERSION = 2;

function resolveTemplateId(id) {
  return TEMPLATE_IDS.includes(id) ? id : DEFAULT_TEMPLATE_ID;
}

/** Map an uploads-relative URL to a path inside uploads/, refusing traversal. */
function resolveUploadPath(videoUrl) {
  const filename = path.basename(String(videoUrl || '').replace(/^\/uploads\//, ''));
  if (!filename) throw new Error('No video file for this project.');
  return path.join(UPLOADS_DIR, filename);
}

async function readProject(id) {
  const data = await readFile(path.join(PROJECTS_DIR, `${id}.json`), 'utf-8');
  return migrateProject(JSON.parse(data));
}

async function resolveProjectVideo(id) {
  const project = await readProject(id);
  const videoPath = resolveUploadPath(project.videoUrl);
  await stat(videoPath);
  return videoPath;
}

/**
 * Bring a project file up to the current shape.
 *
 * Version 1 projects embedded a whole template object. Those embedded copies
 * came from a style format the renderer no longer understands, which is what
 * made reopening an older project render nothing, so they are dropped in favour
 * of a template id.
 */
function migrateProject(project) {
  if (!project || project.version === PROJECT_VERSION) return project;

  const migrated = { ...project, version: PROJECT_VERSION };
  migrated.templateId = resolveTemplateId(
    project.templateId || (project.template && project.template.id)
  );
  delete migrated.template;
  migrated.styleOverrides = project.styleOverrides || {};
  return migrated;
}

// ─── Access control ─────────────────────────────────────────────────────────────
// A single shared password for the internal team. Set REQUIRE_PASSWORD=false to
// drop the gate entirely when the app is only reachable on a trusted network.
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || 'muftcaptions2026';
const REQUIRE_PASSWORD = process.env.REQUIRE_PASSWORD !== 'false';
const SESSION_TOKEN = crypto.createHash('sha256').update(ACCESS_PASSWORD).digest('hex');
const SESSION_COOKIE = 'mc_session';

function cookieValue(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * The session token arrives as a header from fetch calls, but <video> and
 * <img> requests cannot set headers, so the same token is also stored in a
 * cookie for media requests.
 */
function isAuthed(req) {
  if (!REQUIRE_PASSWORD) return true;
  return req.headers['x-access-token'] === SESSION_TOKEN
    || cookieValue(req, SESSION_COOKIE) === SESSION_TOKEN
    // A file download is a plain navigation, which cannot carry a custom header.
    // The cookie normally covers it, but a browser that declines to send the
    // cookie on a programmatic download would fail with nothing to show the
    // user, so the same token is also accepted in the query string.
    || req.query?.token === SESSION_TOKEN;
}

function checkAuth(req, res, next) {
  if (isAuthed(req)) return next();
  return res.status(401).json({ error: 'Unauthorized. Incorrect or missing access token.' });
}

function grantSession(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Lax`);
}

app.post('/api/auth', (req, res) => {
  if (!REQUIRE_PASSWORD || req.body?.password === ACCESS_PASSWORD) {
    grantSession(res);
    return res.json({ success: true, token: SESSION_TOKEN });
  }
  return res.status(401).json({ error: 'Invalid password' });
});

app.get('/api/auth/status', (req, res) => {
  const authed = isAuthed(req);
  // Refresh the media cookie for sessions restored from a stored token.
  if (authed) grantSession(res);
  res.json({
    authenticated: authed,
    passwordRequired: REQUIRE_PASSWORD,
    token: authed ? SESSION_TOKEN : undefined
  });
});

// Uploaded media is only served to an authenticated session; otherwise every
// project video is downloadable by anyone who can guess a filename.
app.use('/uploads', checkAuth, express.static(UPLOADS_DIR));

// ─── Templates & fonts ──────────────────────────────────────────────────────────

app.get('/api/templates', (req, res) => {
  res.json({ templates: listTemplates(), defaultTemplateId: DEFAULT_TEMPLATE_ID });
});

app.get('/api/templates/:id', (req, res) => {
  res.json({ template: getTemplate(req.params.id) });
});

/** Resolve a template with the editor's style tweaks applied. */
app.post('/api/templates/:id/resolve', (req, res) => {
  const template = applyStyleOverrides(
    getTemplate(req.params.id),
    sanitizeOverrides(req.body?.styleOverrides)
  );
  res.json({ template });
});

app.get('/api/fonts', (req, res) => {
  res.json({ families: listFamilies(), custom: FONT_FILES.filter(f => f.custom) });
});

/**
 * POST /api/fonts
 * Upload a font and make it available to templates straight away.
 */
app.post('/api/fonts', checkAuth, fontUpload.single('font'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No font file was uploaded.' });
    const entry = await addCustomFont(
      req.file.buffer,
      req.file.originalname || 'font.ttf',
      req.body.family,
      req.body.weight
    );
    console.log(`[fonts] Added custom font "${entry.family}" (${entry.label}).`);
    res.json({ font: entry, families: listFamilies() });
  } catch (error) {
    res.status(400).json({ error: error?.message || 'Could not add that font.' });
  }
});

app.delete('/api/fonts/:family/:weight', checkAuth, async (req, res) => {
  const removed = await removeCustomFont(req.params.family, req.params.weight);
  if (!removed) return res.status(404).json({ error: 'That font is not installed.' });
  res.json({ success: true, families: listFamilies() });
});

// ─── V2 Endpoints ───────────────────────────────────────────────────────────────

/**
 * POST /api/generate-compositions
 * Main V2 pipeline: Upload → Soniox transcription → Gemini composition → return data
 * Returns: { tokens, compositions, videoUrl, filename }
 */
app.post('/api/generate-compositions', checkAuth, upload.single('media'), async (req, res) => {
  let uploadedPath;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload a video or audio file.' });
    }

    uploadedPath = req.file.path;
    const filename = req.file.originalname || 'input-media.mp4';
    const customTerms = parseCsv(req.body.terms);
    const preserveTerms = [...new Set([...DEFAULT_TERMS, ...customTerms])];

    const fileStat = await stat(req.file.path);
    const fileSizeMB = fileStat.size / (1024 * 1024);
    console.log(`[V2] Processing: ${filename} (${fileSizeMB.toFixed(1)} MB)`);

    // Step 0: Extract audio for large files (>50MB)
    // Sending 160MB video to Soniox times out. Extract just the audio (~5-10MB).
    let audioPath = req.file.path;
    let audioFilename = filename;
    let tempAudioPath = null;

    if (fileSizeMB > 50) {
      console.log('[V2] Large file detected. Extracting audio with FFmpeg...');
      tempAudioPath = req.file.path.replace(/\.[^/.]+$/, '') + '-audio.m4a';
      await new Promise((resolve, reject) => {
        execFile('ffmpeg', [
          '-i', req.file.path,
          '-vn',                // no video
          '-acodec', 'aac',     // AAC audio codec
          '-b:a', '128k',       // 128kbps bitrate
          '-y',                 // overwrite
          tempAudioPath
        ], { timeout: 120000 }, (err, stdout, stderr) => {
          if (err) {
            console.error('[V2] FFmpeg audio extraction failed:', err.message);
            reject(err);
          } else {
            resolve();
          }
        });
      });
      const audioStat = await stat(tempAudioPath);
      console.log(`[V2] Audio extracted: ${(audioStat.size / (1024 * 1024)).toFixed(1)} MB (from ${fileSizeMB.toFixed(1)} MB)`);
      audioPath = tempAudioPath;
      audioFilename = filename.replace(/\.[^/.]+$/, '') + '.m4a';
    }

    // Step 1: Soniox Transcription
    const language = getLanguage(req.body.language || DEFAULT_LANGUAGE_ID);
    console.log(`[V2] Step 1: Soniox transcription (${language.label})...`);
    const media = await readFile(audioPath);
    const client = new SonioxNodeClient({ api_key: SONIOX_API_KEY });
    const transcription = await client.stt.transcribe({
      model: req.body.model || 'stt-async-v5',
      file: media,
      filename: audioFilename,
      wait: true,
      // Hints come from the chosen language rather than being fixed to
      // English and Urdu, which mis-transcribed anything else.
      ...(language.hints.length ? { language_hints: language.hints } : {}),
      enable_language_identification: true,
      enable_speaker_diarization: false,
      context: {
        general: [
          { key: 'domain', value: 'creator explainer videos' },
          { key: 'speech_style', value: language.label },
          { key: 'caption_goal', value: 'Preserve the spoken words and their timing for captioning' }
        ],
        terms: preserveTerms,
        text: language.romanize
          ? 'The speaker mixes languages within a sentence. Preserve tool and brand names exactly.'
          : 'A creator speaking to camera. Preserve tool and brand names exactly.'
      }
    });

    // Clean up temp audio file
    if (tempAudioPath) rm(tempAudioPath, { force: true }).catch(() => {});

    const transcriptObject = transcription?.getTranscript
      ? await transcription.getTranscript()
      : transcription?.transcript;
    const normalized = normalizeSonioxTranscript(transcriptObject || transcription);

    if (!normalized.tokens?.length) {
      return res.status(502).json({
        error: 'Soniox returned no timestamped tokens.',
        hint: 'Try a cleaner audio export or shorter file.'
      });
    }

    // Step 2: Prepare tokens with sequential IDs
    console.log(`[V2] Step 2: Merging ${normalized.tokens.length} sub-word tokens into whole words...`);
    const tokens = prepareTokensForV2(normalized.tokens);
    console.log(`[V2] Merged to ${tokens.length} whole words. (First 5: ${tokens.slice(0, 5).map(t => `"${t.text}"`).join(', ')})`);

    // Step 3: Compose, in chunks.
    //
    // One request for the whole transcript stops working as a video gets longer,
    // and it fails misleadingly: the reply comes back truncated, so it is not
    // valid JSON, so it reads as a parse error rather than as "too long". A
    // 729-word transcript sent a 96KB prompt and got 2KB of an answer back,
    // twice, then fell back to pause-grouping with no transliteration.
    console.log('[V2] Step 3: composition analysis...');
    let compositionSource = 'gemini';

    const composed = await composeInChunks(
      tokens,
      {
        callComposer: callGemini,
        makePrompt: makeV2CompositionPrompt,
        parseResponse: parseV2CompositionResponse,
        schema: V2_COMPOSITION_SCHEMA
      },
      {
        language,
        preserveTerms,
        onProgress: (p) => {
          if (p.failed) console.warn(`[V2] chunk ${p.chunk}/${p.of} (${p.words} words) failed: ${p.error}`);
          else if (p.error) console.warn(`[V2] chunk ${p.chunk}/${p.of} attempt ${p.attempt} failed: ${p.error}`);
          else console.log(`[V2] chunk ${p.chunk}/${p.of} (${p.words} words) -> ${p.lines} lines`);
        }
      }
    );

    const updatedTokens = composed.tokens;
    // Failed chunks are already pause-grouped so every word still has a line.
    // Source says how much of that grouping was the composer vs the fallback.
    if (!composed.chunks || composed.failedRanges.length === composed.chunks) {
      compositionSource = 'fallback';
      console.warn('[V2] No chunk composed — lines are grouped by pauses only.');
    } else if (composed.failedRanges.length) {
      compositionSource = 'partial';
      console.warn(`[V2] ${composed.failedRanges.length} of ${composed.chunks} chunk(s) ` +
        'failed; those stretches are grouped by pause.');
    }

    // Pacing and line breaks are global, so they are applied once over the
    // joined result rather than per chunk.
    const compositions = buildCompositions(updatedTokens, {
      compositions: composed.compositions
    });
    console.log(`[V2] Built ${compositions.length} compositions from ${composed.chunks} chunk(s).`);

    // Did the transliteration actually happen? A composer can return good
    // groupings and simply leave the script alone, which looks like success
    // everywhere except on screen. Counting what came back unconverted catches
    // that, and catches the fallback path too.
    let romanisation = null;
    if (language.romanize) {
      const counted = countUnromanised(updatedTokens);
      // A few stray words are normal — names, or a word the model left alone.
      // A fifth of the transcript means it did not happen at all.
      romanisation = {
        requested: true,
        complete: counted.share <= 0.2,
        remaining: counted.remaining,
        total: counted.total
      };
      if (!romanisation.complete) {
        console.warn(`[V2] Romanisation incomplete: ${counted.remaining} of ${counted.total} ` +
          `words are still in their original script.`);
      }
    }

    // Step 4: Save initial project state and return to frontend
    const videoUrl = `/uploads/${req.file.filename}`;
    const projectId = 'proj-' + Date.now();
    const templateId = resolveTemplateId(req.body.templateId);
    // A project stores which template it uses, not a copy of the template's
    // style data. Storing the copy meant a project could hold a stale or
    // incompatible template shape that broke rendering when reopened.
    const projectState = {
      id: projectId,
      version: PROJECT_VERSION,
      title: filename,
      videoUrl,
      createdAt: Date.now(),
      tokens: updatedTokens,
      compositions,
      templateId,
      styleOverrides: {}
    };
    await writeFile(path.join(PROJECTS_DIR, `${projectId}.json`), JSON.stringify(projectState, null, 2));

    res.json({
      ...projectState,
      projectId,
      filename,
      transcript_text: normalized.text,
      token_count: updatedTokens.length,
      composition_count: compositions.length,
      compositionSource,
      romanisation,
      template: getTemplate(templateId)
    });

  } catch (error) {
    console.error('[V2] Pipeline error:', error);
    res.status(500).json({
      error: error?.message || 'Caption generation failed.',
      hint: 'Check API keys, file format, and internet connection.'
    });
  }
});

/**
 * GET /api/projects
 * Returns a list of all saved projects.
 */
app.get('/api/projects', checkAuth, async (req, res) => {
  try {
    const files = await readdir(PROJECTS_DIR);
    const projects = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = await readFile(path.join(PROJECTS_DIR, file), 'utf-8');
        const proj = JSON.parse(data);
        projects.push({
          id: proj.id,
          title: proj.title || 'Untitled Video',
          videoUrl: proj.videoUrl,
          createdAt: proj.createdAt || 0
        });
      } catch (err) {
        // Skip corrupt project files
      }
    }
    // Sort descending by creation date
    projects.sort((a, b) => b.createdAt - a.createdAt);
    res.json({ projects });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve projects list.' });
  }
});

/**
 * GET /api/projects/:id
 * Loads full project state.
 */
app.get('/api/projects/:id', checkAuth, async (req, res) => {
  try {
    const project = await readProject(req.params.id);
    // Send the resolved template alongside the project so the client never has
    // to reconstruct style data from the saved file.
    res.json({
      ...project,
      template: applyStyleOverrides(getTemplate(project.templateId), project.styleOverrides)
    });
  } catch (error) {
    res.status(404).json({ error: 'Project not found.' });
  }
});

/**
 * GET /api/projects/:id/media
 * Timeline aids for a project: video dimensions, an audio waveform, and the
 * metadata for its filmstrip image. One request rather than three, because the
 * timeline needs all of it before it can draw anything.
 */
app.get('/api/projects/:id/media', checkAuth, async (req, res) => {
  try {
    const videoPath = await resolveProjectVideo(req.params.id);
    const info = await getVideoInfo(videoPath);

    // A missing waveform or filmstrip should degrade the timeline, not break
    // the editor, so each is reported independently.
    const [waveform, filmstrip] = await Promise.all([
      getWaveform(videoPath).catch(err => {
        console.warn(`[media] waveform failed: ${err.message}`);
        return null;
      }),
      getFilmstrip(videoPath, info.duration).catch(err => {
        console.warn(`[media] filmstrip failed: ${err.message}`);
        return null;
      })
    ]);

    res.json({
      video: {
        width: info.width,
        height: info.height,
        duration: info.duration,
        fps: info.fps,
        hasAudio: info.hasAudio,
        aspectRatio: info.height ? info.width / info.height : 9 / 16
      },
      waveform: waveform ? { peaks: waveform.peaks, hasAudio: waveform.hasAudio } : null,
      filmstrip: filmstrip ? {
        url: `/api/projects/${req.params.id}/filmstrip`,
        frames: filmstrip.frames,
        frameWidth: filmstrip.frameWidth,
        frameHeight: filmstrip.frameHeight,
        totalWidth: filmstrip.totalWidth
      } : null
    });
  } catch (error) {
    res.status(404).json({ error: error?.message || 'Project media unavailable.' });
  }
});

app.get('/api/projects/:id/thumbnail', checkAuth, async (req, res) => {
  try {
    const videoPath = await resolveProjectVideo(req.params.id);
    const info = await getVideoInfo(videoPath);
    const poster = await getPoster(videoPath, info.duration);
    res.type('image/jpeg').set('Cache-Control', 'private, max-age=86400').sendFile(poster);
  } catch (error) {
    res.status(404).json({ error: error?.message || 'Thumbnail unavailable.' });
  }
});

/** Rename a project without touching anything else in it. */
app.patch('/api/projects/:id', checkAuth, async (req, res) => {
  try {
    const project = await readProject(req.params.id);
    const title = String(req.body?.title || '').trim().slice(0, 200);
    if (!title) return res.status(400).json({ error: 'A project needs a name.' });

    project.title = title;
    project.updatedAt = Date.now();
    await writeFile(
      path.join(PROJECTS_DIR, `${req.params.id}.json`),
      JSON.stringify(project, null, 2)
    );
    res.json({ success: true, title });
  } catch (error) {
    res.status(404).json({ error: 'Project not found.' });
  }
});

app.get('/api/projects/:id/filmstrip', checkAuth, async (req, res) => {
  try {
    const videoPath = await resolveProjectVideo(req.params.id);
    const info = await getVideoInfo(videoPath);
    const strip = await getFilmstrip(videoPath, info.duration);
    res.type('image/jpeg').set('Cache-Control', 'private, max-age=86400').sendFile(strip.imagePath);
  } catch (error) {
    res.status(404).json({ error: error?.message || 'Filmstrip unavailable.' });
  }
});

/**
 * POST /api/projects/:id
 * Updates full project state.
 */
app.post('/api/projects/:id', checkAuth, async (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || incoming.id !== req.params.id) {
      return res.status(400).json({ error: 'Invalid project state.' });
    }

    // Persist only the fields that define a project. Notably the resolved
    // template object is stripped: it is derived from templateId, and saving a
    // copy is what previously let stale style data into project files.
    const projectState = {
      id: incoming.id,
      version: PROJECT_VERSION,
      title: incoming.title || 'Untitled Video',
      videoUrl: incoming.videoUrl,
      createdAt: incoming.createdAt || Date.now(),
      updatedAt: Date.now(),
      tokens: Array.isArray(incoming.tokens) ? incoming.tokens : [],
      // A composition may carry its own style overrides; those are filtered to
      // known keys too, so a project file cannot accumulate arbitrary data.
      compositions: (Array.isArray(incoming.compositions) ? incoming.compositions : []).map(comp => {
        if (!comp) return comp;
        if (!comp.styleOverrides && !comp.wordOverrides) return comp;
        const { styleOverrides, wordOverrides, ...rest } = comp;
        const line = sanitizeOverrides(styleOverrides);
        const words = sanitizeWordOverrides(wordOverrides);
        const out = { ...rest };
        if (Object.keys(line).length) out.styleOverrides = line;
        if (Object.keys(words).length) out.wordOverrides = words;
        return out;
      }),
      templateId: resolveTemplateId(incoming.templateId),
      styleOverrides: sanitizeOverrides(incoming.styleOverrides)
    };

    await writeFile(path.join(PROJECTS_DIR, `${req.params.id}.json`), JSON.stringify(projectState, null, 2));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save project.' });
  }
});

/**
 * DELETE /api/projects/:id
 * Deletes project file and original video from uploads/
 */
app.delete('/api/projects/:id', checkAuth, async (req, res) => {
  try {
    const projectPath = path.join(PROJECTS_DIR, `${req.params.id}.json`);
    const data = await readFile(projectPath, 'utf-8');
    const proj = JSON.parse(data);

    // Delete associated video in uploads/ if exists
    if (proj.videoUrl) {
      const filename = proj.videoUrl.replace(/^\/uploads\//, '');
      await rm(path.join(UPLOADS_DIR, filename), { force: true }).catch(() => {});
    }

    // Delete project file
    await rm(projectPath, { force: true });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete project.' });
  }
});

/**
 * POST /api/recompute-composition
 * When user changes hero word, recompute a single composition server-side.
 */
app.post('/api/recompute-composition', checkAuth, async (req, res) => {
  try {
    const { composition, newHeroTokenId, tokens } = req.body;
    if (!composition || !newHeroTokenId || !tokens) {
      return res.status(400).json({ error: 'Missing composition, newHeroTokenId, or tokens.' });
    }
    const updated = recomputeComposition(composition, newHeroTokenId, tokens);
    res.json({ composition: updated });
  } catch (error) {
    res.status(400).json({ error: error?.message || 'Recomputation failed.' });
  }
});

// ─── Storage ────────────────────────────────────────────────────────────────────

const STORAGE_DIRS = () => ({
  uploadsDir: UPLOADS_DIR,
  projectsDir: PROJECTS_DIR,
  cacheDir: CACHE_DIR
});

app.get('/api/storage', checkAuth, async (req, res) => {
  try {
    res.json(await getStorageReport(STORAGE_DIRS()));
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Could not read storage usage.' });
  }
});

app.post('/api/storage/cleanup', checkAuth, async (req, res) => {
  try {
    const removed = await runCleanup({ ...STORAGE_DIRS(), manual: true });
    console.log(
      `[cleanup] removed ${removed.exports} export(s), ${removed.orphans} orphan(s), ` +
      `${removed.cache} cache file(s), freeing ${(removed.bytes / 1024 / 1024).toFixed(1)} MB`
    );
    res.json({ removed, storage: await getStorageReport(STORAGE_DIRS()) });
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Cleanup failed.' });
  }
});

app.get('/api/languages', (req, res) => {
  res.json({ languages: listLanguages(), defaultLanguage: DEFAULT_LANGUAGE_ID });
});

// ─── Caption AI status ──────────────────────────────────────────────────────────

/**
 * Whether the composition step is properly configured.
 *
 * Worth exposing because the failure is otherwise invisible: without a working
 * API the pipeline still produces captions, just noticeably worse ones.
 */
app.get('/api/gemini/status', checkAuth, async (req, res) => {
  const [api, soniox] = await Promise.all([
    verifyGeminiAccess(GEMINI_API_KEY, GEMINI_API_MODEL, GEMINI_API_BASE),
    verifySonioxAccess(SONIOX_API_KEY)
  ]);

  // The web session is only probed when it is the path that would be used, since
  // the check costs a real round trip to Google.
  const web = api.ok
    ? { configured: !!GEMINI_COOKIES, ok: false, skipped: true }
    : await checkGeminiWebAccess({ cookies: GEMINI_COOKIES, sapisid: GEMINI_SAPISID });

  res.json({
    ...api,
    transcription: soniox,
    webSession: web,
    usingWebFallback: !api.ok && !!web.ok,
    compositionWorks: api.ok || !!web.ok,
    recommendedModels: GEMINI_MODELS,
    defaultModel: DEFAULT_GEMINI_MODEL
  });
});

/**
 * POST /api/export-text
 * Subtitle and transcript formats, generated from the same composition data the
 * video render uses so every format stays in step with the edits.
 */
const TEXT_FORMATS = {
  srt: { extension: 'srt', mime: 'application/x-subrip', build: compositionsToSrt },
  vtt: { extension: 'vtt', mime: 'text/vtt', build: compositionsToVtt },
  txt: {
    extension: 'txt',
    mime: 'text/plain',
    build: (c, t) => compositionsToText(c, t, { timestamps: false })
  },
  'txt-timestamps': {
    extension: 'txt',
    mime: 'text/plain',
    build: (c, t) => compositionsToText(c, t, { timestamps: true })
  }
};

app.post('/api/export-text', checkAuth, async (req, res) => {
  try {
    const { compositions, tokens, format } = req.body;
    if (!Array.isArray(compositions) || !Array.isArray(tokens)) {
      return res.status(400).json({ error: 'compositions and tokens must be arrays.' });
    }
    const spec = TEXT_FORMATS[format];
    if (!spec) {
      return res.status(400).json({
        error: `Unknown format "${format}". Expected one of: ${Object.keys(TEXT_FORMATS).join(', ')}.`
      });
    }
    res.json({
      content: spec.build(compositions, tokens),
      extension: spec.extension,
      mime: spec.mime
    });
  } catch (error) {
    res.status(400).json({ error: error?.message || 'Text export failed.' });
  }
});

// ─── Export: MP4 render jobs ────────────────────────────────────────────────────

/**
 * POST /api/export
 * Queues a burn-in render and returns a job id. Rendering happens in the
 * background so long videos are not bound to the lifetime of one HTTP request.
 */
app.post('/api/export', checkAuth, async (req, res) => {
  try {
    const { compositions, tokens, templateId, styleOverrides, videoUrl, title } = req.body;

    if (!Array.isArray(compositions) || !compositions.length) {
      return res.status(400).json({ error: 'No compositions to render.' });
    }
    if (!Array.isArray(tokens) || !tokens.length) {
      return res.status(400).json({ error: 'No tokens to render.' });
    }
    if (!videoUrl) {
      return res.status(400).json({ error: 'Missing videoUrl.' });
    }

    let videoPath;
    try {
      videoPath = resolveUploadPath(videoUrl);
      await stat(videoPath);
    } catch {
      return res.status(404).json({ error: 'Source video not found. Please re-upload.' });
    }

    // Fail before queueing rather than after rendering has apparently started:
    // without FFmpeg the job dies with "spawn ffprobe ENOENT", which tells the
    // user nothing about what to install.
    const ffmpeg = await checkFfmpeg();
    if (!ffmpeg.ok) {
      return res.status(503).json({ error: ffmpeg.message });
    }

    const template = applyStyleOverrides(getTemplate(templateId), sanitizeOverrides(styleOverrides));
    const outputPath = path.join(UPLOADS_DIR, `export-${Date.now()}.mp4`);
    const safeTitle = String(title || 'captions').replace(/[^\w\-. ]+/g, '').trim() || 'captions';

    const jobId = startExport({
      videoPath,
      outputPath,
      compositions,
      tokens,
      template,
      downloadName: `${safeTitle}-captioned.mp4`
    });

    res.json({ jobId });
  } catch (error) {
    console.error('[export] Failed to queue:', error);
    res.status(500).json({ error: error?.message || 'Could not start export.' });
  }
});

app.get('/api/export/:id', checkAuth, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Export job not found.' });
  res.json({ ...job, outputPath: undefined, downloadUrl: job.outputPath ? `/api/export/${job.id}/download` : null });
});

app.post('/api/export/:id/cancel', checkAuth, (req, res) => {
  const cancelled = cancelJob(req.params.id);
  if (!cancelled) return res.status(409).json({ error: 'Job already finished or not found.' });
  res.json({ success: true });
});

app.get('/api/export/:id/download', checkAuth, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Export job not found.' });
  if (job.status !== 'completed' || !job.outputPath) {
    return res.status(409).json({ error: `Export is ${job.status}.` });
  }
  res.download(job.outputPath, job.downloadName, err => {
    if (err) console.error('[export] Download error:', err.message);
  });
});

// ─── Start ──────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const width = 41;
  const row = text => `  │${text.padEnd(width)}│`;
  console.log('');
  console.log(`  ┌${'─'.repeat(width)}┐`);
  console.log(row('  Muft Captions — Caption Editor'));
  console.log(row(`  http://localhost:${PORT}`));
  console.log(`  └${'─'.repeat(width)}┘`);
  console.log('');
  reportCaptionAiStatus();
});

/**
 * Say plainly at startup whether captions will actually generate properly.
 *
 * None of these failures stop the app. Without a working composition backend
 * captions are still produced, just with guessed emphasis and no script
 * conversion — easy to miss for weeks. So each dependency is checked once here
 * rather than being discovered at the first upload.
 */
async function reportCaptionAiStatus() {
  // FFmpeg first: it is the most common thing to be missing on a fresh machine,
  // and without it exports fail with an error that says nothing useful.
  const ffmpeg = await checkFfmpeg();
  if (ffmpeg.ok) {
    console.log('[ffmpeg] Ready.');
  } else {
    console.warn(`[ffmpeg] NOT AVAILABLE — exports will fail.\n         ${ffmpeg.message}`);
  }

  // Transcription: nothing works without it.
  if (!SONIOX_API_KEY) {
    console.warn('[soniox] No SONIOX_API_KEY set — transcription will fail. See .env.example.');
  } else {
    try {
      const supported = await getSupportedLanguages(SONIOX_API_KEY);
      const { unsupported } = validateLanguages(supported);
      console.log(`[soniox] Ready: ${supported.size} languages available.`);
      if (unsupported.length) {
        console.warn(
          `[soniox] Hiding ${unsupported.length} language option(s) the model does not support: ` +
          unsupported.join(', ')
        );
      }
    } catch (err) {
      console.warn(`[soniox] Key check failed: ${err.message}`);
    }
  }

  // Composition, preferred path.
  if (GEMINI_API_KEY) {
    const access = await verifyGeminiAccess(GEMINI_API_KEY, GEMINI_API_MODEL, GEMINI_API_BASE);
    if (access.ok) {
      console.log(`[gemini] Ready: ${access.model} via ${access.backend === 'proxy' ? access.base : 'Google'}.`);
      return;
    }
    console.warn(`[gemini] Configured backend not usable: ${access.reason}`);
    if (access.available?.length) {
      console.warn(`[gemini] Available there: ${access.available.slice(0, 12).join(', ')}`);
    }
  }

  // Composition, fallback path.
  if (!GEMINI_COOKIES) {
    console.warn(
      '[gemini] No composition backend configured. Captions will be grouped by pauses\n' +
      '         only, emphasis will be the longest word in each line, and non-Latin\n' +
      '         script will not be converted. Run "npm run credentials:check".'
    );
    return;
  }

  const web = await checkGeminiWebAccess({ cookies: GEMINI_COOKIES, sapisid: GEMINI_SAPISID });
  if (web.ok) {
    console.log(`[gemini] Using the gemini.google.com session (${web.elapsedMs}ms round trip).`);
    console.log('[gemini] That session expires on its own. Prefer GEMINI_API_BASE or GEMINI_API_KEY.');
  } else {
    console.warn(`[gemini] The web session is not working: ${web.reason}`);
    console.warn('[gemini] Captions will be noticeably worse. Run "npm run credentials:check".');
  }
}

