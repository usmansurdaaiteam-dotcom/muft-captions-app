/**
 * soniox.js
 *
 * Talks to the Soniox REST API for everything other than transcription itself:
 * checking the key works and finding out which languages the transcription model
 * actually supports.
 *
 * The language list offered in the UI was originally written from a feature
 * document rather than from the API, and three of its entries (Nepali, Sinhala,
 * Pashto) are not supported by the model at all — choosing one would have
 * transcribed against the wrong hints with no warning. The list is now validated
 * against the live model description at startup.
 */

const API_BASE = 'https://api.soniox.com/v1';

/** Default transcription model, matching the pipeline. */
export const DEFAULT_STT_MODEL = 'stt-async-v5';

let cachedLanguages = null;
let cachedForModel = null;

async function request(path, apiKey) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20000)
  });

  const raw = await response.text();
  if (!response.ok) {
    let message = raw.slice(0, 300);
    try { message = JSON.parse(raw)?.message || message; } catch { /* keep raw */ }
    throw new Error(`Soniox ${response.status}: ${message}`);
  }
  return JSON.parse(raw);
}

/**
 * Language codes a model can transcribe.
 * Cached, because it only changes when Soniox ships a new model.
 */
export async function getSupportedLanguages(apiKey, model = DEFAULT_STT_MODEL) {
  if (!apiKey) throw new Error('No Soniox API key configured.');
  if (cachedLanguages && cachedForModel === model) return cachedLanguages;

  const data = await request('/models', apiKey);
  const entry = (data.models || []).find(m => m.id === model);
  if (!entry) {
    const ids = (data.models || []).map(m => m.id).join(', ');
    throw new Error(`Soniox has no model "${model}". Available: ${ids}`);
  }

  cachedLanguages = new Map((entry.languages || []).map(l => [l.code, l.name]));
  cachedForModel = model;
  return cachedLanguages;
}

/** Check the key works and the pipeline's model exists. */
export async function verifySonioxAccess(apiKey, model = DEFAULT_STT_MODEL) {
  if (!apiKey) return { configured: false, ok: false, reason: 'No SONIOX_API_KEY set.' };
  try {
    const languages = await getSupportedLanguages(apiKey, model);
    return { configured: true, ok: true, model, languageCount: languages.size };
  } catch (err) {
    return { configured: true, ok: false, model, reason: err.message };
  }
}
