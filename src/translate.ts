// On-device translation with Chrome's built-in Translator API, when the browser has it.
// The explanation never leaves the device on this path. Gemini in the cloud is the fallback.

type TranslatorLike = { translate(s: string): Promise<string>; destroy?: () => void };
type TranslatorStatic = {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(o: { sourceLanguage: string; targetLanguage: string; monitor?: (m: EventTarget) => void }): Promise<TranslatorLike>;
};

export const LANG_CODES: Record<string, string> = {
  'हिन्दी (Hindi)': 'hi',
  'తెలుగు (Telugu)': 'te',
  'தமிழ் (Tamil)': 'ta',
  'ಕನ್ನಡ (Kannada)': 'kn',
  'മലയാളം (Malayalam)': 'ml',
  'मराठी (Marathi)': 'mr',
  'বাংলা (Bengali)': 'bn',
  'ગુજરાતી (Gujarati)': 'gu',
  'ਪੰਜਾਬੀ (Punjabi)': 'pa',
  'اردو (Urdu)': 'ur',
  Español: 'es',
  English: 'en',
};

const api = () => (self as unknown as { Translator?: TranslatorStatic }).Translator;

/** 'available' | 'downloadable' | 'downloading' | 'unavailable' */
export async function onDeviceTranslation(code: string): Promise<string> {
  const T = api();
  if (!T || code === 'en') return 'unavailable';
  try {
    return await T.availability({ sourceLanguage: 'en', targetLanguage: code });
  } catch {
    return 'unavailable';
  }
}

/** Translate a list of strings on the device. Must start from a user action if a download is needed. */
export async function translateOnDevice(code: string, texts: string[], onProgress?: (p: number) => void): Promise<string[]> {
  const T = api();
  if (!T) throw new Error('No on-device translator in this browser');
  const tr = await T.create({
    sourceLanguage: 'en',
    targetLanguage: code,
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => onProgress?.((e as unknown as { loaded: number }).loaded));
    },
  });
  try {
    const out: string[] = [];
    for (const t of texts) out.push(t.trim() ? await tr.translate(t) : t);
    return out;
  } finally {
    tr.destroy?.();
  }
}

/** Read text aloud with an on-device voice for the language, if one is installed. */
export function speak(text: string, code: string): boolean {
  if (!('speechSynthesis' in self)) return false;
  speechSynthesis.cancel();
  const voices = speechSynthesis.getVoices();
  const want = code === 'en' ? 'en-IN' : `${code}-IN`;
  const voice = voices.find((v) => v.lang === want) || voices.find((v) => v.lang.startsWith(code)) || null;
  if (!voice && code !== 'en') return false;
  const u = new SpeechSynthesisUtterance(text);
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  }
  u.rate = 0.95;
  speechSynthesis.speak(u);
  return true;
}
