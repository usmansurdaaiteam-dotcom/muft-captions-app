/**
 * languages.js
 *
 * Languages offered for transcription, shared by the upload form and the
 * transcription request.
 *
 * These were previously hardcoded to English and Urdu in the pipeline with no
 * way to change them, so a clip in any other language was transcribed against
 * the wrong hints.
 *
 * `hints` are the codes passed to Soniox as `language_hints`. Giving it two
 * codes for a bilingual pairing is deliberate: the speaker switches mid-sentence
 * and both need to be recognised.
 *
 * Every code here is supported by Soniox's stt-async-v5, checked against the
 * live model description. An earlier version of this list was written from a
 * feature document and included Nepali, Sinhala and Pashto, none of which the
 * model supports — picking one would have transcribed against hints Soniox
 * ignores, with no warning. validateLanguages() keeps this honest at startup.
 */

export const LANGUAGES = [
  // The bilingual pairings this tool was built around come first.
  { id: 'en-ur', label: 'English + Urdu (Roman Urdu output)', hints: ['en', 'ur'], romanize: true, group: 'Bilingual' },
  { id: 'en-hi', label: 'English + Hindi (Roman output)', hints: ['en', 'hi'], romanize: true, group: 'Bilingual' },
  { id: 'en-pa', label: 'English + Punjabi', hints: ['en', 'pa'], romanize: true, group: 'Bilingual' },
  { id: 'en-bn', label: 'English + Bengali', hints: ['en', 'bn'], romanize: true, group: 'Bilingual' },
  { id: 'en-ar', label: 'English + Arabic', hints: ['en', 'ar'], romanize: false, group: 'Bilingual' },

  { id: 'en', label: 'English', hints: ['en'], romanize: false, group: 'Single language' },
  { id: 'ur', label: 'Urdu', hints: ['ur'], romanize: false, group: 'Single language' },
  { id: 'hi', label: 'Hindi', hints: ['hi'], romanize: false, group: 'Single language' },
  { id: 'pa', label: 'Punjabi', hints: ['pa'], romanize: false, group: 'Single language' },
  { id: 'bn', label: 'Bengali', hints: ['bn'], romanize: false, group: 'Single language' },
  { id: 'ta', label: 'Tamil', hints: ['ta'], romanize: false, group: 'Single language' },
  { id: 'te', label: 'Telugu', hints: ['te'], romanize: false, group: 'Single language' },
  { id: 'mr', label: 'Marathi', hints: ['mr'], romanize: false, group: 'Single language' },
  { id: 'gu', label: 'Gujarati', hints: ['gu'], romanize: false, group: 'Single language' },
  { id: 'ml', label: 'Malayalam', hints: ['ml'], romanize: false, group: 'Single language' },
  { id: 'kn', label: 'Kannada', hints: ['kn'], romanize: false, group: 'Single language' },
  { id: 'ar', label: 'Arabic', hints: ['ar'], romanize: false, group: 'Single language' },
  { id: 'fa', label: 'Persian', hints: ['fa'], romanize: false, group: 'Single language' },
  { id: 'tr', label: 'Turkish', hints: ['tr'], romanize: false, group: 'Single language' },
  { id: 'th', label: 'Thai', hints: ['th'], romanize: false, group: 'Single language' },
  { id: 'vi', label: 'Vietnamese', hints: ['vi'], romanize: false, group: 'Single language' },
  { id: 'sw', label: 'Swahili', hints: ['sw'], romanize: false, group: 'Single language' },
  { id: 'tl', label: 'Tagalog', hints: ['tl'], romanize: false, group: 'Single language' },
  { id: 'he', label: 'Hebrew', hints: ['he'], romanize: false, group: 'Single language' },
  { id: 'uk', label: 'Ukrainian', hints: ['uk'], romanize: false, group: 'Single language' },
  { id: 'pl', label: 'Polish', hints: ['pl'], romanize: false, group: 'Single language' },
  { id: 'nl', label: 'Dutch', hints: ['nl'], romanize: false, group: 'Single language' },
  { id: 'id', label: 'Indonesian', hints: ['id'], romanize: false, group: 'Single language' },
  { id: 'ms', label: 'Malay', hints: ['ms'], romanize: false, group: 'Single language' },
  { id: 'es', label: 'Spanish', hints: ['es'], romanize: false, group: 'Single language' },
  { id: 'pt', label: 'Portuguese', hints: ['pt'], romanize: false, group: 'Single language' },
  { id: 'fr', label: 'French', hints: ['fr'], romanize: false, group: 'Single language' },
  { id: 'de', label: 'German', hints: ['de'], romanize: false, group: 'Single language' },
  { id: 'it', label: 'Italian', hints: ['it'], romanize: false, group: 'Single language' },
  { id: 'ru', label: 'Russian', hints: ['ru'], romanize: false, group: 'Single language' },
  { id: 'zh', label: 'Chinese', hints: ['zh'], romanize: false, group: 'Single language' },
  { id: 'ja', label: 'Japanese', hints: ['ja'], romanize: false, group: 'Single language' },
  { id: 'ko', label: 'Korean', hints: ['ko'], romanize: false, group: 'Single language' },

  // Let the recogniser decide when the language genuinely is not known.
  { id: 'auto', label: 'Detect automatically', hints: [], romanize: false, group: 'Other' }
];

export const DEFAULT_LANGUAGE_ID = 'en-ur';

export function getLanguage(id) {
  return LANGUAGES.find(l => l.id === id)
    || LANGUAGES.find(l => l.id === DEFAULT_LANGUAGE_ID);
}

/**
 * Codes the transcription model cannot actually handle.
 *
 * Kept as a mutable set rather than baked in, so a language Soniox adds later
 * starts working without a code change, and one they drop stops being offered.
 */
const unsupported = new Set();

/**
 * Compare the list above against what the model really supports.
 * @param {Map<string,string>} supportedCodes from src/soniox.js
 * @returns {{unsupported: string[], checked: number}}
 */
export function validateLanguages(supportedCodes) {
  unsupported.clear();
  if (!supportedCodes || !supportedCodes.size) return { unsupported: [], checked: 0 };

  for (const language of LANGUAGES) {
    if (!language.hints.length) continue; // automatic detection has no codes
    const missing = language.hints.filter(code => !supportedCodes.has(code));
    if (missing.length) unsupported.add(language.id);
  }

  return { unsupported: [...unsupported], checked: LANGUAGES.length };
}

/** Grouped for an option list, without the transcription-only fields. */
export function listLanguages() {
  const groups = new Map();
  for (const lang of LANGUAGES) {
    // Hide anything the model has been confirmed not to support, rather than
    // letting someone pick an option that silently does nothing.
    if (unsupported.has(lang.id)) continue;
    if (!groups.has(lang.group)) groups.set(lang.group, []);
    groups.get(lang.group).push({ id: lang.id, label: lang.label });
  }
  return [...groups.entries()].map(([group, options]) => ({ group, options }));
}
