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
  { id: 'ne', label: 'Nepali', hints: ['ne'], romanize: false, group: 'Single language' },
  { id: 'si', label: 'Sinhala', hints: ['si'], romanize: false, group: 'Single language' },
  { id: 'ar', label: 'Arabic', hints: ['ar'], romanize: false, group: 'Single language' },
  { id: 'fa', label: 'Persian', hints: ['fa'], romanize: false, group: 'Single language' },
  { id: 'ps', label: 'Pashto', hints: ['ps'], romanize: false, group: 'Single language' },
  { id: 'tr', label: 'Turkish', hints: ['tr'], romanize: false, group: 'Single language' },
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

/** Grouped for an option list, without the transcription-only fields. */
export function listLanguages() {
  const groups = new Map();
  for (const lang of LANGUAGES) {
    if (!groups.has(lang.group)) groups.set(lang.group, []);
    groups.get(lang.group).push({ id: lang.id, label: lang.label });
  }
  return [...groups.entries()].map(([group, options]) => ({ group, options }));
}
