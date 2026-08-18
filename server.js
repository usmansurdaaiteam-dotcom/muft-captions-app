import express from 'express';
import multer from 'multer';
import { readFile, writeFile, rm, mkdir, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { SonioxNodeClient } from '@soniox/node';
import {
  buildCaptionBlocks,
  captionsToSrt,
  makeLlmCleanupPrompt,
  mergeCleanedCaptions,
  normalizeSonioxTranscript,
  safeSettings,
  prepareTokensForV2,
  makeV2CompositionPrompt,
  parseV2CompositionResponse,
  compositionsToSrt
} from './src/caption-utils.js';
import {
  buildCompositions,
  buildFallbackCompositions,
  recomputeComposition,
  resolvePositions,
  getWordRenderData,
  GLOW_TEMPLATE,
  LAYOUTS,
  LAYOUT_IDS
} from './src/composition-engine.js';
import { exportVideo, getVideoInfo } from './src/frame-renderer.js';

// ─── Credentials ────────────────────────────────────────────────────────────────
const SONIOX_API_KEY = "88b33b8360aa0c294115cb89e49bbf439d935925fde65c322e67d1a34443dadd";
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
await mkdir(UPLOADS_DIR, { recursive: true }).catch(() => {});
await mkdir(PROJECTS_DIR, { recursive: true }).catch(() => {});

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

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/templates', express.static(path.join(__dirname, 'templates')));

// ─── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_TERMS = [
  'CapCut', 'Gemini', 'ChatGPT', 'Google Flow', 'Flow', 'Nano Banana',
  'Kling', 'Veo', 'Sora', 'Runway', 'Midjourney', 'Daffy Studio',
  'MUFT AI', 'Rasta', 'contact sheet', 'moodboard', 'prompt', 'AI campaign'
];

function parseCsv(value = '') {
  return String(value).split(',').map(x => x.trim()).filter(Boolean);
}

// ─── Authentication (VPS Protection) ──────────────────────────────────────────
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || 'muftcaptions2026';
const SESSION_TOKEN = crypto.createHash('sha256').update(ACCESS_PASSWORD).digest('hex');

function checkAuth(req, res, next) {
  const token = req.headers['x-access-token'];
  if (token !== SESSION_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized. Incorrect or missing access token.' });
  }
  next();
}

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === ACCESS_PASSWORD) {
    return res.json({ success: true, token: SESSION_TOKEN });
  }
  return res.status(401).json({ error: 'Invalid password' });
});

app.get('/api/auth/status', (req, res) => {
  const token = req.headers['x-access-token'];
  if (token === SESSION_TOKEN) {
    return res.json({ authenticated: true });
  }
  return res.json({ authenticated: false });
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

    // Try Gemini up to 2 times
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[V2] Gemini attempt ${attempt}...`);
        const geminiReply = await callGeminiWeb(geminiPrompt);
        console.log(`[V2] Gemini responded (${geminiReply.length} chars). Parsing compositions...`);
        const parsed = parseV2CompositionResponse(geminiReply, tokens);
        updatedTokens = parsed.tokens;
        compositions = buildCompositions(updatedTokens, { compositions: parsed.compositions });
        console.log(`[V2] ✓ Built ${compositions.length} compositions from Gemini.`);
        break; // Success
      } catch (geminiError) {
        console.error(`[V2] Gemini attempt ${attempt} failed:`, geminiError.message);
        if (attempt === 2) {
          console.log('[V2] Using fallback composition builder...');
          compositions = buildFallbackCompositions(tokens);
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
    const projectState = {
      id: projectId,
      title: filename,
      videoUrl,
      createdAt: Date.now(),
      tokens: updatedTokens,
      compositions,
      template: GLOW_TEMPLATE
    };
    await writeFile(path.join(PROJECTS_DIR, `${projectId}.json`), JSON.stringify(projectState, null, 2));

    res.json({
      projectId,
      filename,
      videoUrl,
      transcript_text: normalized.text,
      token_count: updatedTokens.length,
      composition_count: compositions.length,
      tokens: updatedTokens,
      compositions,
      template: GLOW_TEMPLATE,
      layouts: LAYOUT_IDS
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
    const data = await readFile(path.join(PROJECTS_DIR, `${req.params.id}.json`), 'utf-8');
    res.json(JSON.parse(data));
  } catch (error) {
    res.status(404).json({ error: 'Project not found.' });
  }
});

/**
 * POST /api/projects/:id
 * Updates full project state.
 */
app.post('/api/projects/:id', checkAuth, async (req, res) => {
  try {
    const projectState = req.body;
    if (!projectState || projectState.id !== req.params.id) {
      return res.status(400).json({ error: 'Invalid project state.' });
    }
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

/**
 * GET /api/template
 * Returns the Glow template configuration.
 */
app.get('/api/template', (req, res) => {
  res.json({
    template: GLOW_TEMPLATE,
    layouts: LAYOUT_IDS.map(id => ({
      id,
      name: LAYOUTS[id].name,
      description: LAYOUTS[id].description
    }))
  });
});

/**
 * POST /api/render-data
 * Get per-word render data for all compositions (used by canvas exporter).
 */
app.post('/api/render-data', checkAuth, async (req, res) => {
  try {
    const { compositions, tokens, styleOverrides } = req.body;
    if (!Array.isArray(compositions) || !Array.isArray(tokens)) {
      return res.status(400).json({ error: 'compositions and tokens must be arrays.' });
    }

    // Apply style overrides to template
    const template = JSON.parse(JSON.stringify(GLOW_TEMPLATE));
    if (styleOverrides) {
      if (styleOverrides.heroColor) template.hero.color = styleOverrides.heroColor;
      if (styleOverrides.supportColor) template.support.color = styleOverrides.supportColor;
      if (styleOverrides.heroFontSize) template.hero.fontSize = styleOverrides.heroFontSize;
      if (styleOverrides.supportFontSize) template.support.fontSize = styleOverrides.supportFontSize;
      if (styleOverrides.fontFamily) {
        template.hero.fontFamily = styleOverrides.fontFamily;
        template.support.fontFamily = styleOverrides.fontFamily;
      }
    }

    const renderFrames = compositions.map(comp => ({
      compositionId: comp.id,
      startMs: comp.start_ms,
      endMs: comp.end_ms,
      words: getWordRenderData(comp, tokens, template)
    }));

    res.json({ renderFrames, template });
  } catch (error) {
    res.status(400).json({ error: error?.message || 'Render data generation failed.' });
  }
});

// ─── V1 Backward-Compatible Endpoints ───────────────────────────────────────────

app.post('/api/generate-captions-auto', upload.single('media'), async (req, res) => {
  let uploadedPath;
  try {
    if (!req.file) return res.status(400).json({ error: 'Please upload a media file.' });

    uploadedPath = req.file.path;
    const media = await readFile(req.file.path);
    const filename = req.file.originalname || 'input-media.mp4';
    const customTerms = parseCsv(req.body.terms);
    const preserveTerms = [...new Set([...DEFAULT_TERMS, ...customTerms])];
    const settings = safeSettings({
      maxChars: req.body.maxChars,
      maxDurationMs: req.body.maxDurationMs,
      minDurationMs: req.body.minDurationMs,
      pauseBreakMs: req.body.pauseBreakMs,
      languageSwitchBreak: req.body.languageSwitchBreak !== 'false'
    });

    const client = new SonioxNodeClient({ api_key: SONIOX_API_KEY });
    const transcription = await client.stt.transcribe({
      model: req.body.model || 'stt-async-v5',
      file: media,
      filename,
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
        text: 'The speaker is a Pakistani AI content creator.'
      }
    });

    const transcriptObject = transcription?.getTranscript ? await transcription.getTranscript() : transcription?.transcript;
    const normalized = normalizeSonioxTranscript(transcriptObject || transcription);
    if (!normalized.tokens?.length) {
      return res.status(502).json({ error: 'Soniox returned no timestamped tokens.' });
    }

    const captions = buildCaptionBlocks(normalized.tokens, settings);
    const llmPrompt = makeLlmCleanupPrompt(captions, { preserveTerms });
    const geminiReply = await callGeminiWeb(llmPrompt);
    const merged = mergeCleanedCaptions(captions, geminiReply);
    const srt = captionsToSrt(merged);

    res.json({ filename, captions: merged, srt, caption_count: captions.length });
  } catch (error) {
    console.error("V1 auto generation error:", error);
    res.status(500).json({ error: error?.message || 'Auto generation failed.' });
  } finally {
    if (uploadedPath) rm(uploadedPath, { force: true }).catch(() => {});
  }
});

// ─── Export: Server-side MP4 ────────────────────────────────────────────────────

/**
 * POST /api/export-mp4
 * Server-side frame-by-frame export.
 * Renders caption frames with @napi-rs/canvas, pipes to FFmpeg for compositing.
 * Returns the finished MP4 file as a download.
 */
app.post('/api/export-mp4', checkAuth, async (req, res) => {
  try {
    const { compositions, tokens, templateId, animation, videoUrl } = req.body;

    if (!compositions?.length || !tokens?.length || !videoUrl) {
      return res.status(400).json({ error: 'Missing compositions, tokens, or videoUrl.' });
    }

    // Resolve video path from URL
    const videoFilename = videoUrl.replace(/^\/uploads\//, '');
    const videoPath = path.join(__dirname, 'uploads', videoFilename);

    // Verify video exists
    try { await stat(videoPath); } catch {
      return res.status(404).json({ error: 'Video file not found. Please re-upload.' });
    }

    // Use custom template overrides from body if provided, fallback to disk config
    let template = req.body.template;
    if (!template) {
      const tmplId = templateId || 'kalakar-glow';
      const templatePath = path.join(__dirname, 'templates', `${tmplId}.json`);
      try {
        const tmplData = await readFile(templatePath, 'utf-8');
        template = JSON.parse(tmplData);
      } catch {
        return res.status(400).json({ error: `Template "${tmplId}" not found.` });
      }
    }

    // Animation config (separate from template)
    const animationConfig = animation || {
      type: 'pop_bounce',
      scaleFrom: 0.82,
      scalePeak: 1.15,
      durationMs: 220,
      peakAtMs: 130
    };

    const outputFilename = `export-${Date.now()}.mp4`;
    const outputPath = path.join(__dirname, 'uploads', outputFilename);

    console.log(`[Export] Starting server-side export for: ${videoFilename}`);
    console.log(`[Export] Template: ${template.name}, ${compositions.length} compositions, ${tokens.length} tokens`);
    console.log(`[Export] Custom overrides received: ${req.body.template ? 'YES' : 'NO'}`);
    console.log(`[Export] Resolved Fonts - Hero: "${template.hero?.fontFamily}", Support: "${template.support?.fontFamily}"`);

    // Build token map
    const tokenMap = new Map(tokens.map(t => [t.id, t]));

    // Export with progress logging
    await exportVideo(videoPath, outputPath, compositions, tokenMap, template, animationConfig, (frame, total) => {
      console.log(`[Export] Frame ${frame}/${total} (${Math.round(frame/total*100)}%)`);
    });

    console.log(`[Export] ✓ Export complete: ${outputFilename}`);

    // Send the file as download
    res.download(outputPath, `muft-captions-${Date.now()}.mp4`, (err) => {
      if (err) console.error('[Export] Download error:', err.message);
      // Clean up export file after download (or after 5 min timeout)
      setTimeout(() => {
        rm(outputPath, { force: true }).catch(() => {});
      }, 5 * 60 * 1000);
    });

  } catch (error) {
    console.error('[Export] Export failed:', error);
    res.status(500).json({
      error: error?.message || 'Export failed.',
      hint: 'Check FFmpeg installation and video file.'
    });
  }
});

// ─── Start ──────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  ┌─────────────────────────────────────────┐`);
  console.log(`  │  Muft Captions V2 — Caption Editor      │`);
  console.log(`  │  http://localhost:${PORT}                    │`);
  console.log(`  └─────────────────────────────────────────┘\n`);
});

