import express from 'express';
import multer from 'multer';
import { readFile, writeFile, rm, mkdir, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { SonioxNodeClient } from '@soniox/node';
import {
  normalizeSonioxTranscript,
  prepareTokensForV2,
  makeV2CompositionPrompt,
  parseV2CompositionResponse,
  compositionsToSrt
} from './src/caption-utils.js';
import {
  buildCompositions,
  buildFallbackCompositions,
  recomputeComposition
} from './src/composition-engine.js';
import { registerFonts } from './src/render/fonts-node.js';
import { getTemplate, listTemplates, TEMPLATE_IDS, DEFAULT_TEMPLATE_ID } from './src/render/templates.js';
import { listFamilies, buildFontFaceCss } from './src/render/fonts.js';
import { applyStyleOverrides, sanitizeOverrides } from './src/render/style-overrides.js';
import { startExport, getJob, cancelJob, getVideoInfo } from './src/render/exporter.js';
import {
  configureCache as configureMediaCache,
  getWaveform,
  getFilmstrip
} from './src/media/analyze.js';

// ─── Credentials ────────────────────────────────────────────────────────────────
// Environment variables win; the inline values are the existing internal-team
// defaults so the app keeps working without any configuration.
const SONIOX_API_KEY = process.env.SONIOX_API_KEY
  || "88b33b8360aa0c294115cb89e49bbf439d935925fde65c322e67d1a34443dadd";

/**
 * Preferred path for the caption-composition step.
 *
 * The cookie-based Gemini web client below still works but depends on Google
 * session cookies, which expire on their own after a few weeks. When they do,
 * composition analysis fails and the pipeline silently falls back to picking
 * the longest word in each phrase and skips Roman-Urdu conversion entirely.
 * Setting GEMINI_API_KEY switches to the official API and removes that whole
 * failure mode.
 */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_API_MODEL = process.env.GEMINI_API_MODEL || 'gemini-2.0-flash';
const GEMINI_COOKIES = `__Secure-1PAPISID=V6xV-XcSUIwIAl2-/AlcaLgykPhdSd4YLC; __Secure-1PSID=g.a000_Qhw2T9OhwUGK_soDrogaS7yAXpa68w8k929b0koecsL6psiRabzPFhaHcZn73fDZl6GHgACgYKAboSARASFQHGX2Mi6qgmPYCHfwX7ZBC5qspWbBoVAUF8yKoG4h7LaZ3P1350mgx4IxiP0076; __Secure-1PSIDCC=AKEyXzXgcCUfjt0JQbEIJ-aSHFKvZQ5aLAZu9gdnLU5gWaaUgHWkK0VMfjfhiqQfx_oCM5hc; __Secure-1PSIDTS=sidts-CjEByojQU9rMv0KOJfOm-1h1AY-8T_B5QGNVa_HXMl0yDTogxlUw15fkKJr6q8efZPbkEAA; __Secure-3PAPISID=V6xV-XcSUIwIAl2-/AlcaLgykPhdSd4YLC; __Secure-3PSID=g.a000_Qhw2T9OhwUGK_soDrogaS7yAXpa68w8k929b0koecsL6psiJcikN6-d8p0qcRLXJseMbgACgYKAYcSARASFQHGX2MibiloPeTjOwf_c4ITNHKsQRoVAUF8yKqvBQaWkh9YDuXdOTnFJvyk0076; __Secure-3PSIDCC=AKEyXzXP_qVnzywb4q1RBazyy42fyc10uo3LVEEessv0LXE-pV3Zz8viniEVwseza0EropKGsA; __Secure-3PSIDTS=sidts-CjEByojQU9rMv0KOJfOm-1h1AY-8T_B5QGNVa_HXMl0yDTogxlUw15fkKJr6q8efZPbkEAA; _ga=GA1.1.1235861555.1781907535; _ga_BF8Q35BMLM=GS2.1.s1781907535$o1$g1$t1781907537$j58$l0$h0; _ga_WC57KJ50ZZ=GS2.1.s1781907535$o1$g1$t1781907549$j46$l0$h0; _gcl_au=1.1.1725113739.1781907535; APISID=nzDM-ZU4Gjo25lRP/ASMpwLO3Av3WUJreD; COMPASS=gemini-pd=CjwACWuJV93jFYb_b6k1ZbZc5AVi75OXfwVJx6huPFdJgLZgT-iphNSBtyIyTho-2Gurv4U86El7hPmdVFUQzqPc0QYaZgAJa4lX3m9vZsmI6QCgE9yrrbqnT-F_4Be9ffLz_hJnaVJuLoKujHVLrcWURyjXXkDC9BOAOs4u0MyYa17Ls82BAQ_52wOSXejtkKpYLWPS4jjvCXpw8oLZHpNUblsq59rRO7JDiyABMAE; HSID=AdTEr0K3d0enQTv13; NID=532=ilgUIr_tSLbp6cjkHuxdsdYCHK5KyOwSuTlB_CGeUk2X5IBlMjbOahvyKKqSTRescfVA24MUAFTnrhdhMpP2XuSEMJsPtwd2z-2c3DeE1BusyHFj3GBxBKw-c-dv41obw4svN8wXYNKV14iJdECVJUxf7_dTgOyIs5M7K8j_TgruZlvKUa8Se_cKHN_iPaekzG6lyb9nyn7OFwHoScPkwrh1kx6M2BdqO-o93q-AmqaG-1FWW9WN12dU74vcQDKH2pCZFgHkHxwST-Q2tkzQQxxizrglPASqACWS1lC2gXbkrMOjyL5JXyqiA3nRVGtz1qhP19bKLAQqlYUVBAnBAHLPHYI6WBn5XS4IdAu3BN0RHG10BsgT_G3nN19Pj24X3QYg433AYZHkBUzIPNborIW6-MzdtMyYnKJLsIJ2fsP7R-ZKwExd1efirFa7KbwHidK8CHZDHl522U6mKPysy2edorWKL9fGuxen5qARabfCjI-Y2kHZKnpDMP-jVe7bEt500F6KHCtjbnVpN_cILIo62aC79vFxHTcusbgqbXWzXEuJKjsledTUuyMlaZa3J8asJAHH05C0_hH0D49XB9lMA3xq1aJENm3OI6YKz4FkZPQrCARxs3dyhGS7p9Bg; S=billing-ui-v3=0djzWSEegPZhH7bKNoYUVc-6GlC2uLa9wAMRmod-_68:billing-ui-v3-efe=0djzWSEegPZhH7bKNoYUVc-6GlC2uLa9wAMRmod-_68; SAPISID=V6xV-XcSUIwIAl2-/AlcaLgykPhdSd4YLC; SID=g.a000_Qhw2T9OhwUGK_soDrogaS7yAXpa68w8k929b0koecsL6psimdmBj2gZ8tIgJEUXMZysgwACgYKAS4SARASFQHGX2MiriaKGwynhWbVnUjkP7cC_xoVAUF8yKobAl95iI4nuPoc9KCLZ-yd0076; SIDCC=AKEyXzVA2tYqrZj9gjGXdxkd_SvYrYFb0zFCdihqnfV6f6JGQRt_aT0OyvlX1dS1KPXd4Bs6; SSID=AYiY2HTNnjtEVRTMa`;
const GEMINI_SAPISID = 'V6xV-XcSUIwIAl2-/AlcaLgykPhdSd4YLC';

// ─── Gemini Web Client ──────────────────────────────────────────────────────────

function makeSapisidHash(sapisid) {
  const ts = Math.floor(Date.now() / 1000);
  const hash = crypto.createHash('sha1').update(`${ts} ${sapisid} https://gemini.google.com`).digest('hex');
  return `SAPISIDHASH ${ts}_${hash}`;
}

function cleanGeminiText(text) {
  return text.replace(
    /```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n.*?```\n?/gs,
    ''
  ).trim();
}

function extractResponseText(raw) {
  const texts = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    if (!line.includes('"wrb.fr"') || line.length < 200) continue;
    try {
      const arr = JSON.parse(line);
      const innerStr = arr[0][2];
      if (!innerStr || innerStr.length < 50) continue;
      const inner = JSON.parse(innerStr);
      if (Array.isArray(inner) && inner.length > 4 && inner[4]) {
        for (const part of inner[4]) {
          if (Array.isArray(part) && part.length > 1 && part[1]) {
            if (Array.isArray(part[1])) {
              for (const t of part[1]) {
                if (typeof t === 'string' && t.length > 0) texts.push(t);
              }
            }
          }
        }
      }
    } catch (e) { /* skip */ }
  }

  // If we found response text, use it even if BardErrorInfo appeared
  let text = "";
  for (let i = texts.length - 1; i >= 0; i--) {
    if (texts[i].trim()) { text = texts[i]; break; }
  }

  if (text) return cleanGeminiText(text);

  // Only error if we have NO extracted text
  if (raw.includes('BardErrorInfo')) {
    const m = raw.match(/BardErrorInfo\s*\[(\d+)\]/);
    throw new Error(`Gemini upstream rejected request: BardErrorInfo [${m ? m[1] : 'unknown'}]`);
  }

  throw new Error('No response text found in Gemini reply.');
}

/** Official Gemini API. Used whenever GEMINI_API_KEY is configured. */
async function callGeminiApi(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_API_MODEL}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 8192 }
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Gemini API error ${response.status}: ${detail.slice(0, 300)}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('');
  if (!text) throw new Error('Gemini API returned no text.');
  return text;
}

/**
 * Ask Gemini to analyse captions, preferring the API key and falling back to
 * the cookie-based web client so existing deployments keep working unchanged.
 */
async function callGemini(prompt) {
  if (GEMINI_API_KEY) {
    try {
      return await callGeminiApi(prompt);
    } catch (err) {
      console.warn(`[gemini] API call failed (${err.message}); falling back to web client.`);
    }
  }
  return callGeminiWeb(prompt);
}

async function callGeminiWeb(prompt) {
  const inner = Array(80).fill(null);
  inner[0] = [prompt, 0, null, null, null, null, 0];
  inner[1] = ["en"];
  inner[2] = ["", "", "", null, null, null, null, null, null, ""];
  inner[6] = [0];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[4]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [2];
  inner[53] = 0;
  inner[59] = crypto.randomUUID();
  inner[61] = [];
  inner[68] = 1;
  inner[79] = 1;

  const outer = [null, JSON.stringify(inner)];
  const bodyParams = new URLSearchParams();
  bodyParams.append('f.req', JSON.stringify(outer));

  const reqid = Math.floor(Date.now() / 1000) % 1000000;
  const url = `https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=boq_assistant-bard-web-server_20260525.09_p0&hl=en&_reqid=${reqid}&rt=c`;

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Origin': 'https://gemini.google.com',
    'Referer': 'https://gemini.google.com/app',
    'X-Same-Domain': '1',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Cookie': GEMINI_COOKIES,
    'Authorization': makeSapisidHash(GEMINI_SAPISID)
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: headers,
    body: bodyParams.toString()
  });

  if (!response.ok) {
    throw new Error(`Gemini service error: ${response.status} ${response.statusText}`);
  }

  const rawText = await response.text();
  return extractResponseText(rawText);
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

registerFonts();

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
    || cookieValue(req, SESSION_COOKIE) === SESSION_TOKEN;
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
  res.json({ families: listFamilies() });
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
    console.log('[V2] Step 1: Soniox transcription...');
    const media = await readFile(audioPath);
    const client = new SonioxNodeClient({ api_key: SONIOX_API_KEY });
    const transcription = await client.stt.transcribe({
      model: req.body.model || 'stt-async-v5',
      file: media,
      filename: audioFilename,
      wait: true,
      language_hints: ['en', 'ur'],
      enable_language_identification: true,
      enable_speaker_diarization: false,
      context: {
        general: [
          { key: 'domain', value: 'AI creator explainer videos' },
          { key: 'speech_style', value: 'Pakistani bilingual English and Urdu code-switching' },
          { key: 'caption_goal', value: 'Keep English as English and Urdu as Urdu for later Roman Urdu conversion' }
        ],
        terms: preserveTerms,
        text: 'The speaker is a Pakistani AI content creator. He often switches between English and Urdu in the same sentence. Preserve AI tool names and creator vocabulary exactly.'
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

    // Step 3: Send to Gemini for composition analysis
    console.log('[V2] Step 3: Gemini composition analysis...');
    const geminiPrompt = makeV2CompositionPrompt(tokens, { preserveTerms });
    console.log(`[V2] Gemini prompt size: ${(geminiPrompt.length / 1024).toFixed(1)}KB`);
    let compositions;
    let updatedTokens = tokens;
    let compositionSource = 'gemini';

    // Try Gemini up to 2 times
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[V2] Gemini attempt ${attempt}...`);
        const geminiReply = await callGemini(geminiPrompt);
        console.log(`[V2] Gemini responded (${geminiReply.length} chars). Parsing compositions...`);
        const parsed = parseV2CompositionResponse(geminiReply, tokens);
        updatedTokens = parsed.tokens;
        compositions = buildCompositions(updatedTokens, { compositions: parsed.compositions });
        console.log(`[V2] ✓ Built ${compositions.length} compositions from Gemini.`);
        break; // Success
      } catch (geminiError) {
        console.error(`[V2] Gemini attempt ${attempt} failed:`, geminiError.message);
        if (attempt === 2) {
          // The fallback picks the longest word as the hero and does no
          // Roman-Urdu conversion, so the result is noticeably worse. Surface
          // it to the client rather than letting the quality drop silently.
          console.warn('[V2] Gemini unavailable — using fallback composition builder.');
          compositions = buildFallbackCompositions(tokens);
          compositionSource = 'fallback';
          console.log(`[V2] Built ${compositions.length} fallback compositions.`);
        } else {
          // Wait 2 seconds before retry
          await new Promise(r => setTimeout(r, 2000));
        }
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
      compositions: Array.isArray(incoming.compositions) ? incoming.compositions : [],
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

/**
 * POST /api/export-srt
 * Generate SRT from compositions (fallback export).
 */
app.post('/api/export-srt', checkAuth, async (req, res) => {
  try {
    const { compositions, tokens } = req.body;
    if (!Array.isArray(compositions) || !Array.isArray(tokens)) {
      return res.status(400).json({ error: 'compositions and tokens must be arrays.' });
    }
    const srt = compositionsToSrt(compositions, tokens);
    res.json({ srt });
  } catch (error) {
    res.status(400).json({ error: error?.message || 'SRT export failed.' });
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
  console.log(`\n  ┌─────────────────────────────────────────┐`);
  console.log(`  │  Muft Captions V2 — Caption Editor      │`);
  console.log(`  │  http://localhost:${PORT}                    │`);
  console.log(`  └─────────────────────────────────────────┘\n`);
});

