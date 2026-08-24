/**
 * gemini.js
 *
 * The Gemini client used for caption composition, plus the catalogue of models
 * worth pointing it at.
 *
 * Works against two backends, because the request shape is the same for both:
 *
 * 1. Google's own API at generativelanguage.googleapis.com, with a real API key.
 * 2. A Gemini-compatible proxy such as AIStudioToAPI, which drives a logged-in
 *    Google AI Studio session in a browser and exposes
 *    `POST /v1beta/models/{model}:generateContent` on port 7860. Set
 *    GEMINI_API_BASE to its /v1beta URL and GEMINI_API_KEY to one of its
 *    configured API_KEYS. It reads the same `x-goog-api-key` header Google does,
 *    so nothing else has to change.
 *
 * Model choice is data here rather than a bare string in the server: names retire
 * on published dates and a retired name returns a flat 404, so the availability
 * notes live next to the ids.
 *
 * Model facts verified against Google's docs on 2026-08-19. A proxy backed by AI
 * Studio may offer a different set, which is what listAvailableModels is for —
 * treat the catalogue below as "preferred if available", not as the truth.
 */

const GOOGLE_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Trailing slashes are easy to leave in an env var and break every URL. */
function normalizeBase(base) {
  return String(base || GOOGLE_API_BASE).replace(/\/+$/, '');
}

/** True when pointed at something other than Google's own endpoint. */
function isProxyBase(base) {
  return !normalizeBase(base).startsWith('https://generativelanguage.googleapis.com');
}

/**
 * Models suitable for caption composition, best first.
 *
 * The task is: group timed words into phrases, choose the most impactful word in
 * each, and transliterate non-Latin script. It needs solid instruction
 * following, reliable JSON and decent multilingual handling — not deep
 * reasoning, tools, or images.
 *
 * `availability` matters more than raw capability for an internal tool nobody
 * is watching. Google publishes retirement dates, and models flagged
 * "short-term availability" can be retired as little as 45 days after a
 * replacement ships.
 */
export const GEMINI_MODELS = [
  {
    id: 'gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    recommended: true,
    stage: 'stable',
    availableUntil: 'at least 2027-05-19',
    notes: 'Full Flash intelligence with a long availability guarantee. The best default for this workload.'
  },
  {
    id: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash-Lite',
    stage: 'stable',
    availableUntil: 'at least 2027-07-21',
    notes: 'Cheapest, and the longest guarantee of any current model. Google positions Flash-Lite for translation and simple data processing, which is close to this task. Worth comparing before paying for Flash.'
  },
  {
    id: 'gemini-3.7-flash',
    label: 'Gemini 3.7 Flash',
    stage: 'stable',
    availableUntil: 'unannounced — short-term availability',
    notes: 'Newest Flash. Flagged short-term availability, so it can retire on short notice; only pick it if someone will keep this setting current.'
  },
  {
    id: 'gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    stage: 'stable',
    availableUntil: 'unannounced — short-term availability',
    notes: 'Same short-term availability caveat as 3.7 Flash.'
  },
  {
    id: 'gemini-3-flash-preview',
    label: 'Gemini 3 Flash (preview)',
    stage: 'preview',
    availableUntil: 'unannounced — preview',
    notes: 'Has a free tier on the Gemini API, so useful for trying this without enabling billing. Preview models are retired once their stable version lands.'
  },
  {
    id: 'gemini-3.1-flash-lite',
    label: 'Gemini 3.1 Flash-Lite',
    stage: 'stable',
    availableUntil: 'at least 2027-05-07',
    notes: 'Previous Flash-Lite. Keep as a fallback if 3.5 Flash-Lite ever misbehaves.'
  },
  {
    id: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro (preview)',
    stage: 'preview',
    availableUntil: 'unannounced — preview',
    notes: 'Far more capable than this task needs, several times the price, and no free tier. Only worth trying if emphasis choices look poor on Flash.'
  }
];

export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';

/**
 * Models known to be gone. A request using one of these returns 404, which is
 * otherwise a confusing failure to diagnose.
 */
const RETIRED_MODELS = {
  'gemini-2.0-flash': 'retired 2026-06-01',
  'gemini-2.0-flash-001': 'retired 2026-06-01',
  'gemini-2.0-flash-lite': 'retired 2026-06-01',
  'gemini-2.0-flash-lite-001': 'retired 2026-06-01',
  'gemini-1.5-flash': 'retired',
  'gemini-1.5-pro': 'retired'
};

export function retirementNoteFor(model) {
  return RETIRED_MODELS[model] || null;
}

/** Gemini 3 changed enough defaults that the request has to be built differently. */
function isGemini3(model) {
  return /^gemini-3/.test(String(model || ''));
}

/**
 * Build the request body.
 *
 * Two Gemini 3 specifics are handled here:
 *
 * - Temperature is left unset. Google explicitly advises against lowering it on
 *   Gemini 3 (the default is 1.0) because it can cause looping and degraded
 *   output. The previous code set 0.4 for determinism, which is exactly the
 *   pattern their migration notes tell you to remove.
 * - Thinking defaults to `high` on Gemini 3, which spends latency and output
 *   tokens on reasoning this task does not need, so it is pinned to `low`.
 */
function buildRequestBody(prompt, { model, schema, thinkingLevel = 'low' }) {
  const generationConfig = { maxOutputTokens: 32768 };

  if (schema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseJsonSchema = schema;
  }

  if (isGemini3(model)) {
    generationConfig.thinkingConfig = { thinkingLevel };
  }

  return {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig
  };
}

function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  // Thinking models can return thought parts alongside the answer; those carry
  // `thought: true` and must not be treated as the response.
  return parts
    .filter(part => !part.thought && typeof part.text === 'string')
    .map(part => part.text)
    .join('');
}

/**
 * Call the API once with a given body.
 * Returns { ok, text, status, error }, never throws for HTTP-level failures, so
 * the caller can decide whether a retry with a simpler body is worthwhile.
 */
async function attempt(url, apiKey, body, base) {
  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
  // Gemini-compatible proxies commonly document `Authorization: Bearer`. Sending
  // it as well costs nothing there, but it is not sent to Google, which treats a
  // Bearer token as OAuth and would reject an API key supplied that way.
  if (isProxyBase(base)) headers.Authorization = `Bearer ${apiKey}`;

  let response;
  try {
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: isProxyBase(base)
        ? `Could not reach the Gemini proxy at ${base}: ${err.message}. Is it running?`
        : `Could not reach the Gemini API: ${err.message}`
    };
  }

  const raw = await response.text();
  if (!response.ok) {
    let message = raw.slice(0, 400);
    try {
      const parsed = JSON.parse(raw);
      message = parsed?.error?.message || message;
    } catch { /* keep the raw body */ }
    return { ok: false, status: response.status, error: message };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, status: response.status, error: 'Gemini returned a response that was not JSON.' };
  }

  const finishReason = data?.candidates?.[0]?.finishReason;
  const text = extractText(data);

  if (!text) {
    const blocked = data?.promptFeedback?.blockReason;
    if (blocked) return { ok: false, status: 200, error: `Gemini blocked the request (${blocked}).` };
    if (finishReason === 'MAX_TOKENS') {
      return { ok: false, status: 200, error: 'Gemini hit its output limit before finishing. Try a shorter video.' };
    }
    return { ok: false, status: 200, error: `Gemini returned no text (finishReason: ${finishReason || 'unknown'}).` };
  }

  return { ok: true, text, finishReason, usage: data?.usageMetadata };
}

/**
 * Ask Gemini for a completion.
 *
 * Degrades the request rather than failing outright when the API rejects part of
 * it: structured output and thinking controls are both relatively new and their
 * accepted shapes have changed before, so an unrecognised field should cost a
 * retry, not the whole feature.
 *
 * @param {string} prompt
 * @param {{apiKey: string, model?: string, schema?: object}} options
 * @returns {Promise<{text: string, model: string, usage?: object, degraded?: string}>}
 */
export async function callGeminiApi(prompt, {
  apiKey,
  model = DEFAULT_GEMINI_MODEL,
  schema = null,
  base = GOOGLE_API_BASE
} = {}) {
  if (!apiKey) throw new Error('No Gemini API key configured.');

  const apiBase = normalizeBase(base);

  // Retirement dates apply to Google's own API. A proxy driving AI Studio may
  // still expose an older name, so this is only enforced against Google.
  const retired = retirementNoteFor(model);
  if (retired && !isProxyBase(apiBase)) {
    throw new Error(
      `The model "${model}" was ${retired} and no longer exists on Google's API. ` +
      `Set GEMINI_API_MODEL to a current model such as "${DEFAULT_GEMINI_MODEL}".`
    );
  }

  const url = `${apiBase}/models/${encodeURIComponent(model)}:generateContent`;

  const bodies = [
    { body: buildRequestBody(prompt, { model, schema }), degraded: null },
    // Drop the schema but keep JSON mode: the tolerant parser can handle the
    // result, and this survives a schema the API will not accept.
    { body: buildRequestBody(prompt, { model, schema: null }), degraded: 'without a response schema' },
    // Last resort: plain text, no thinking config at all.
    {
      body: { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 32768 } },
      degraded: 'without structured output or thinking controls'
    }
  ];

  let lastError = null;
  for (let i = 0; i < bodies.length; i++) {
    const { body, degraded } = bodies[i];
    const result = await attempt(url, apiKey, body, apiBase);

    if (result.ok) {
      if (degraded) console.warn(`[gemini] Succeeded ${degraded}.`);
      return { text: result.text, model, usage: result.usage, degraded };
    }

    lastError = result;

    // A 404 means the model name is wrong or gone; retrying the same name with a
    // simpler body cannot help.
    if (result.status === 404) {
      throw new Error(
        `No model called "${model}" is available at ${apiBase}. ` +
        (isProxyBase(apiBase)
          ? 'Check which models your proxy exposes — run "npm run gemini:doctor".'
          : `It may have been retired. Try "${DEFAULT_GEMINI_MODEL}".`) +
        ` (${result.error})`
      );
    }
    // Bad key, quota, or permissions are equally not worth retrying.
    if ([401, 403, 429].includes(result.status)) break;
    // Anything other than a rejected request body is not going to be fixed by
    // sending a simpler one.
    if (result.status !== 400) break;

    console.warn(`[gemini] Request rejected (${result.error.slice(0, 160)}); retrying with a simpler request.`);
  }

  throw new Error(lastError?.error || 'The Gemini API call failed.');
}

/** Model ids this key can actually use for generateContent. */
export async function listAvailableModels(apiKey, base = GOOGLE_API_BASE) {
  if (!apiKey) throw new Error('No Gemini API key configured.');

  const apiBase = normalizeBase(base);
  const headers = { 'x-goog-api-key': apiKey };
  if (isProxyBase(apiBase)) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(`${apiBase}/models?pageSize=200`, { headers });
  const raw = await response.text();
  if (!response.ok) {
    let message = raw.slice(0, 300);
    try { message = JSON.parse(raw)?.error?.message || message; } catch { /* keep raw */ }
    throw new Error(`Could not list models: ${message}`);
  }

  const data = JSON.parse(raw);
  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => String(m.name || '').replace(/^models\//, ''))
    .filter(Boolean)
    .sort();
}

/**
 * Check that the configured key and model are usable, without spending a
 * generation. Surfaces a wrong or retired model immediately rather than at the
 * first upload, hours later.
 */
export async function verifyGeminiAccess(apiKey, model, base = GOOGLE_API_BASE) {
  const apiBase = normalizeBase(base);
  const backend = isProxyBase(apiBase) ? 'proxy' : 'google';

  if (!apiKey) {
    return { configured: false, ok: false, backend, base: apiBase, reason: 'No GEMINI_API_KEY set.' };
  }

  const retired = retirementNoteFor(model);
  if (retired && backend === 'google') {
    return {
      configured: true,
      ok: false,
      backend,
      base: apiBase,
      model,
      reason: `"${model}" was ${retired}. Set GEMINI_API_MODEL to a current model such as "${DEFAULT_GEMINI_MODEL}".`
    };
  }

  try {
    const available = await listAvailableModels(apiKey, apiBase);
    if (!available.includes(model)) {
      const suggestion = GEMINI_MODELS.map(m => m.id).find(id => available.includes(id))
        || available.find(id => /flash/i.test(id));
      return {
        configured: true,
        ok: false,
        backend,
        base: apiBase,
        model,
        available,
        reason: `"${model}" is not available at ${apiBase}.` +
          (suggestion ? ` "${suggestion}" is.` : ' No Gemini text model was offered.')
      };
    }
    return { configured: true, ok: true, backend, base: apiBase, model, available };
  } catch (err) {
    return { configured: true, ok: false, backend, base: apiBase, model, reason: err.message };
  }
}

export { GOOGLE_API_BASE };
