/**
 * caption-utils.js (V2)
 * 
 * All caption utility functions. Contains both V1 functions (backward compat)
 * and new V2 functions for composition-based captions.
 */

// ─── V1 Functions (unchanged) ──────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  maxChars: 42,
  maxDurationMs: 2800,
  minDurationMs: 700,
  pauseBreakMs: 520,
  languageSwitchBreak: true
};

const URDU_ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;
const TRAILING_PUNCT_RE = /[.!?؟،,;:]$/;

export function safeSettings(input = {}) {
  return {
    maxChars: clampInt(input.maxChars, 20, 80, DEFAULT_SETTINGS.maxChars),
    maxDurationMs: clampInt(input.maxDurationMs, 1200, 6000, DEFAULT_SETTINGS.maxDurationMs),
    minDurationMs: clampInt(input.minDurationMs, 400, 2000, DEFAULT_SETTINGS.minDurationMs),
    pauseBreakMs: clampInt(input.pauseBreakMs, 200, 1500, DEFAULT_SETTINGS.pauseBreakMs),
    languageSwitchBreak: input.languageSwitchBreak !== false
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function isUrduScript(text = '') {
  return URDU_ARABIC_RE.test(text);
}

export function normalizeTokenText(text = '') {
  return String(text || '').replace(/\s+/g, ' ');
}

export function joinTokenTexts(tokens) {
  return tokens.map((token) => token.text || '').join('').replace(/\s+/g, ' ').trim();
}

export function tokenLanguage(token) {
  return token.language || token.source_language || 'unknown';
}

function dominantLanguage(tokens) {
  const counts = new Map();
  for (const token of tokens) {
    const lang = tokenLanguage(token);
    counts.set(lang, (counts.get(lang) || 0) + Math.max(1, String(token.text || '').trim().length));
  }
  let best = 'unknown';
  let bestCount = -1;
  for (const [lang, count] of counts.entries()) {
    if (count > bestCount) {
      best = lang;
      bestCount = count;
    }
  }
  return best;
}

function cleanTokens(tokens = []) {
  return tokens
    .filter((token) => token && !token.is_audio_event)
    .filter((token) => token.translation_status !== 'translation')
    .filter((token) => typeof token.text === 'string' && token.text.trim() !== '')
    .filter((token) => Number.isFinite(token.start_ms) && Number.isFinite(token.end_ms))
    .sort((a, b) => a.start_ms - b.start_ms);
}

export function buildCaptionBlocks(tokens = [], rawSettings = {}) {
  const settings = safeSettings(rawSettings);
  const usable = cleanTokens(tokens);
  const blocks = [];
  let group = [];

  const flush = () => {
    if (!group.length) return;
    const text = joinTokenTexts(group);
    if (!text) {
      group = [];
      return;
    }
    const start = group[0].start_ms;
    let end = group[group.length - 1].end_ms;
    if (end - start < settings.minDurationMs) end = start + settings.minDurationMs;

    blocks.push({
      id: blocks.length + 1,
      start_ms: start,
      end_ms: end,
      text,
      detected_language: dominantLanguage(group),
      contains_urdu_script: isUrduScript(text),
      token_count: group.length
    });
    group = [];
  };

  for (const token of usable) {
    if (!group.length) {
      group.push(token);
      continue;
    }

    const currentText = joinTokenTexts(group);
    const proposedText = joinTokenTexts([...group, token]);
    const previous = group[group.length - 1];
    const gap = token.start_ms - previous.end_ms;
    const durationIfAdded = token.end_ms - group[0].start_ms;
    const langChanged = tokenLanguage(previous) !== tokenLanguage(token) && tokenLanguage(previous) !== 'unknown' && tokenLanguage(token) !== 'unknown';
    const endedPhrase = TRAILING_PUNCT_RE.test(currentText);

    const shouldBreak =
      gap > settings.pauseBreakMs ||
      durationIfAdded > settings.maxDurationMs ||
      proposedText.length > settings.maxChars ||
      (settings.languageSwitchBreak && langChanged && currentText.length >= 14) ||
      (endedPhrase && currentText.length >= 18 && durationIfAdded > settings.minDurationMs);

    if (shouldBreak) flush();
    group.push(token);
  }
  flush();
  return blocks;
}

export function msToSrtTime(ms) {
  const totalMs = Math.max(0, Math.round(Number(ms) || 0));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${String(millis).padStart(3, '0')}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function captionsToSrt(captions = []) {
  return captions
    .map((caption, index) => {
      const text = String(caption.text || '').replace(/\r/g, '').trim();
      return `${index + 1}\n${msToSrtTime(caption.start_ms)} --> ${msToSrtTime(caption.end_ms)}\n${text}`;
    })
    .join('\n\n') + '\n';
}

export function makeLlmCleanupPrompt(captions = [], options = {}) {
  const preserveTerms = options.preserveTerms || [];
  const payload = captions.map(({ id, text, detected_language, contains_urdu_script }) => ({
    id,
    text,
    detected_language,
    contains_urdu_script
  }));

  return `You are cleaning subtitles for a Pakistani bilingual creator.\n\nGOAL:\nReturn clean subtitle text where English stays in English and Urdu/Hindi speech becomes natural Roman Urdu.\n\nSTRICT RULES:\n1. Do NOT translate Urdu into English. Convert it to Roman Urdu only.\n2. Keep English words, brand names, AI tool names, and technical terms in English.\n3. Preserve the exact same IDs.\n4. Do NOT change timing because timing is handled elsewhere.\n5. Keep each caption short and spoken, not formal.\n6. Use natural Pakistani Roman Urdu spelling: "phir", "hum", "yeh", "karna", "banate hain", "aap", "main".\n7. Remove obvious ASR weirdness only when meaning is clear.\n8. Do not add emojis.\n9. Do not add commentary or markdown.\n10. Return ONLY valid JSON in this exact shape: [{"id":1,"text":"..."}].\n\nPRESERVE THESE TERMS EXACTLY WHEN THEY APPEAR:\n${preserveTerms.length ? preserveTerms.join(', ') : 'CapCut, Gemini, ChatGPT, Google Flow, Nano Banana, Kling, Veo, Sora, Runway, Midjourney, Daffy Studio, MUFT AI'}\n\nINPUT CAPTIONS:\n${JSON.stringify(payload, null, 2)}`;
}

export function mergeCleanedCaptions(originalCaptions = [], cleanedInput) {
  let cleaned = cleanedInput;
  if (typeof cleanedInput === 'string') {
    cleaned = extractJsonArrayRobust(cleanedInput);
  }
  if (!Array.isArray(cleaned)) {
    throw new Error('Cleaned captions must be a JSON array like [{"id":1,"text":"..."}].');
  }

  const byId = new Map(cleaned.map((item) => [Number(item.id), item]));
  return originalCaptions.map((caption) => {
    const updated = byId.get(Number(caption.id));
    return {
      ...caption,
      text: updated && typeof updated.text === 'string' && updated.text.trim() ? updated.text.trim() : caption.text
    };
  });
}

function extractJson(input) {
  const trimmed = String(input || '').trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return trimmed;
  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (match) return match[1].trim();
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) return trimmed.slice(start, end + 1);
  const objStart = trimmed.indexOf('{');
  const objEnd = trimmed.lastIndexOf('}');
  if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) return trimmed.slice(objStart, objEnd + 1);
  return trimmed;
}

function extractJsonArrayRobust(input) {
  const trimmed = String(input || '').trim();
  
  try {
    const standard = extractJson(trimmed);
    const parsed = JSON.parse(standard);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object' && parsed.compositions) return parsed.compositions;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch (e) {
    // fallback
  }

  const objects = [];
  let braceCount = 0;
  let currentObjectStart = -1;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (char === '\\') { escapeNext = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (!inString) {
      if (char === '{') {
        if (braceCount === 0) currentObjectStart = i;
        braceCount++;
      } else if (char === '}') {
        braceCount--;
        if (braceCount === 0 && currentObjectStart !== -1) {
          const objStr = trimmed.slice(currentObjectStart, i + 1);
          try {
            const parsedObj = JSON.parse(objStr);
            if (parsedObj && typeof parsedObj === 'object') objects.push(parsedObj);
          } catch (err) { /* skip malformed */ }
          currentObjectStart = -1;
        }
      }
    }
  }

  if (objects.length > 0) return objects;
  throw new Error('Could not parse JSON from Gemini response.');
}

export function normalizeSonioxTranscript(transcription) {
  const transcript = transcription?.transcript || transcription;
  const tokens = transcript?.tokens || [];
  const text = transcript?.text || tokens.map((t) => t.text || '').join('').trim();
  return { text, tokens };
}


// ─── V2 Functions ──────────────────────────────────────────────────────────────

/**
 * Prepare Soniox tokens for the V2 pipeline.
 * 
 * CRITICAL: Soniox returns sub-word tokens, not whole words!
 * e.g., " start" + "ed" = "started", " char" + "acter" = "character"
 * 
 * A token whose text starts with a space (or is the first token) is a NEW word.
 * A token without a leading space is a CONTINUATION of the previous word.
 * 
 * This function merges sub-word tokens into whole words with correct timestamps.
 */
export function prepareTokensForV2(rawTokens = []) {
  // Step 1: Clean and sort raw tokens
  const cleaned = rawTokens
    .filter(t => t && !t.is_audio_event)
    .filter(t => t.translation_status !== 'translation')
    .filter(t => typeof t.text === 'string' && t.text !== '')
    .filter(t => Number.isFinite(t.start_ms) && Number.isFinite(t.end_ms))
    .sort((a, b) => a.start_ms - b.start_ms);

  if (!cleaned.length) return [];

  // Step 2: Merge sub-word tokens into whole words
  const words = [];
  let currentWord = null;

  for (const token of cleaned) {
    const text = token.text;
    const startsWithSpace = text.startsWith(' ') || text.startsWith('\u00a0');
    const isNewWord = startsWithSpace || !currentWord;

    if (isNewWord) {
      // Flush previous word
      if (currentWord && currentWord.text.trim()) {
        words.push(currentWord);
      }
      // Start new word
      currentWord = {
        text: text,
        start_ms: token.start_ms,
        end_ms: token.end_ms,
        language: token.language || token.source_language || 'unknown',
        _subTokens: [token]
      };
    } else {
      // Continuation of current word — append text and extend end time
      currentWord.text += text;
      currentWord.end_ms = Math.max(currentWord.end_ms, token.end_ms);
      currentWord._subTokens.push(token);
      // If any sub-token has a language, prefer it
      if (token.language && token.language !== 'unknown') {
        currentWord.language = token.language;
      }
    }
  }

  // Flush last word
  if (currentWord && currentWord.text.trim()) {
    words.push(currentWord);
  }

  // Step 3: Assign IDs and finalize
  return words.map((w, i) => ({
    id: i + 1,
    text: w.text.trim(),
    start_ms: w.start_ms,
    end_ms: w.end_ms,
    language: w.language || 'unknown',
    contains_urdu_script: isUrduScript(w.text)
  }));
}

/**
 * Create the V2 Gemini prompt that asks for:
 * 1. Clean Urdu → Roman Urdu per word
 * 2. Hero word detection per phrase
 * 3. Phrase grouping from tokens
 * 4. Layout assignment
 */
export function makeV2CompositionPrompt(tokens, options = {}) {
  const preserveTerms = options.preserveTerms || [
    'CapCut', 'Gemini', 'ChatGPT', 'Google Flow', 'Flow', 'Nano Banana',
    'Kling', 'Veo', 'Sora', 'Runway', 'Midjourney', 'Daffy Studio',
    'MUFT AI', 'Rasta', 'contact sheet', 'moodboard', 'prompt', 'AI campaign'
  ];

  const tokenData = tokens.map((t, index) => {
    const nextToken = tokens[index + 1];
    const duration = Math.max(0, t.end_ms - t.start_ms);
    const gap = nextToken ? Math.max(0, nextToken.start_ms - t.end_ms) : 0;
    return {
      id: t.id,
      text: t.text.trim(),
      lang: t.language,
      urdu: t.contains_urdu_script,
      duration_ms: duration,
      gap_to_next_ms: gap
    };
  });

  return `You are a caption composition engine for a Pakistani bilingual YouTube creator.

TASK:
Given a list of spoken words (tokens) with IDs, group them into visual caption compositions. Each composition is a phrase of 1-8 words that will be displayed as kinetic typography.

FOR EACH COMPOSITION:
1. Group nearby tokens into natural spoken phrases (1-8 words per group).
2. Pick ONE hero word per group — the most impactful, emotional, or key word. This word will be displayed LARGE and in a highlight color.
3. Clean any Urdu script into natural Roman Urdu. Keep English as English.
4. Assign a "comp_type" to each composition. This controls the visual style:
   - "emphasis" (35% MAX of compositions): The hero word is displayed LARGE and colored, with before/after support words. Use ONLY for phrases where one word is truly important — emotional peaks, key moments, strong nouns/verbs. Be selective. Quality over quantity.
   - "plain" (60-65% of compositions): ALL words displayed in normal white text, no hero emphasis. Use for most lines — transitions, filler phrases, normal conversational flow. This is the DEFAULT type.
   - "spotlight" (OPTIONAL, very rare): ONLY the hero word shown big and centered. Use only for truly dramatic moments. Most scripts need 0-2 spotlights total.

RULES FOR comp_type:
- STRICTLY NO two consecutive "emphasis" compositions. After one emphasis, the NEXT composition MUST be "plain". No exceptions.
- Only about 1 in 3 lines should be emphasis. If there are 60 compositions, only ~20 should be emphasis.
- Pick emphasis lines based on script meaning — emphasize emotional words, key moments, important nouns. NOT random words.
- "plain" is the default. When in doubt, use "plain".
- The pattern should feel like a professional editor: emphasis lines are impactful BECAUSE they are rare.

TIMING & READABILITY RULES:
1. Observe Speech Pauses: If gap_to_next_ms >= 300 (ms), you must end the current composition there. Never group words across a pause of 300ms or more.
2. Pacing / Pacing Rhythms: Group words so each composition stays on the screen for at least 800ms - 1200ms to ensure readability.
3. Speaking Speed Adjustment:
   - Fast speech (short durations): Group 3-6 words so the line doesn't flash and disappear.
   - Slow speech (long durations/pauses): Group 1-3 words to align with the slow pacing.
   - Avoid compositions with less than 600ms total duration unless unavoidable.

GENERAL RULES:
- hero_token_id must be one of the token IDs in that composition's token_ids array.
- For "plain" compositions, still include hero_token_id (pick the most notable word) but it won't be visually emphasized.
- Do NOT translate Urdu to English. Convert to Roman Urdu only.
- Keep brand names and technical terms exactly: ${preserveTerms.join(', ')}
- Use natural Pakistani Roman Urdu: "phir", "hum", "yeh", "karna", "banate hain"
- Return ONLY valid JSON, no markdown, no commentary.

RETURN FORMAT:
{
  "compositions": [
    {
      "token_ids": [1, 2, 3, 4, 5],
      "hero_token_id": 4,
      "comp_type": "emphasis",
      "cleaned_texts": { "1": "this time", "2": "i'm", "3": "actually", "4": "BUILDING", "5": "something" }
    },
    {
      "token_ids": [6, 7, 8],
      "hero_token_id": 7,
      "comp_type": "plain",
      "cleaned_texts": {}
    },
    {
      "token_ids": [9],
      "hero_token_id": 9,
      "comp_type": "spotlight",
      "cleaned_texts": {}
    }
  ]
}

The "cleaned_texts" maps token ID to cleaned text (Roman Urdu conversion applied).
Only include cleaned_texts entries where the text changed from original (Urdu→Roman Urdu conversion).

INPUT TOKENS:
${JSON.stringify(tokenData, null, 2)}`;
}

/**
 * Parse Gemini's V2 composition response and merge with token data.
 */
export function parseV2CompositionResponse(geminiOutput, tokens) {
  let parsed;
  
  if (typeof geminiOutput === 'string') {
    const jsonStr = extractJson(geminiOutput);
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      // Try extracting just the compositions array
      const arrStr = extractJsonArrayRobust(geminiOutput);
      if (Array.isArray(arrStr)) {
        parsed = { compositions: arrStr };
      } else {
        throw new Error('Failed to parse Gemini V2 response as JSON.');
      }
    }
  } else {
    parsed = geminiOutput;
  }

  // Handle both { compositions: [...] } and direct array
  let compositions = parsed?.compositions || parsed;
  if (!Array.isArray(compositions)) {
    throw new Error('Expected compositions array in Gemini response.');
  }

  // Apply cleaned texts to tokens
  const tokenMap = new Map(tokens.map(t => [t.id, { ...t }]));

  for (const comp of compositions) {
    if (comp.cleaned_texts && typeof comp.cleaned_texts === 'object') {
      for (const [idStr, cleanedText] of Object.entries(comp.cleaned_texts)) {
        const id = Number(idStr);
        const token = tokenMap.get(id);
        if (token && typeof cleanedText === 'string' && cleanedText.trim()) {
          token.text = cleanedText.trim();
        }
      }
    }
  }

  const updatedTokens = tokens.map(t => tokenMap.get(t.id) || t);

  return {
    compositions,
    tokens: updatedTokens
  };
}

/**
 * Generate a simple SRT from compositions (fallback export).
 */
export function compositionsToSrt(compositions = [], tokens = []) {
  const tokenMap = new Map(tokens.map(t => [t.id, t]));
  
  return compositions
    .map((comp, index) => {
      const compTokens = comp.token_ids.map(id => tokenMap.get(id)).filter(Boolean);
      const text = compTokens.map(t => t.text.trim()).join(' ');
      const startMs = comp.start_ms || compTokens[0]?.start_ms || 0;
      const endMs = comp.end_ms || compTokens[compTokens.length - 1]?.end_ms || 0;
      return `${index + 1}\n${msToSrtTime(startMs)} --> ${msToSrtTime(endMs)}\n${text}`;
    })
    .join('\n\n') + '\n';
}
