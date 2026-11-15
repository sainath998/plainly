// All model calls go through Firebase AI Logic.
//
// - Private work (reading the photo, finding personal details, explaining,
//   private questions) uses ONLY_ON_DEVICE: Gemini Nano in Chrome. If the device
//   model isn't available, these calls fail rather than quietly using the cloud.
// - Cloud work (translation into Indian languages, deeper questions) uses
//   ONLY_IN_CLOUD, and is only ever given the redacted text.
// - Quick follow-ups use PREFER_ON_DEVICE, and are also given only redacted
//   text, because they may fall back to the cloud.

import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, type GenerativeModel } from 'firebase/ai';
import { app, configured, settings } from './firebase';

const ai = getAI(app, { backend: new GoogleAIBackend() });

type LM = {
  availability: (opts?: unknown) => Promise<'available' | 'downloadable' | 'downloading' | 'unavailable'>;
};

export type DeviceState = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported';

export async function deviceState(): Promise<DeviceState> {
  const lm = (self as unknown as { LanguageModel?: LM }).LanguageModel;
  if (!lm) return 'unsupported';
  try {
    return await lm.availability({ expectedInputs: [{ type: 'text' }, { type: 'image' }] });
  } catch {
    try {
      return await lm.availability();
    } catch {
      return 'unavailable';
    }
  }
}

const deviceInputs = {
  expectedInputs: [{ type: 'text' as const, languages: ['en'] }, { type: 'image' as const }],
  expectedOutputs: [{ type: 'text' as const, languages: ['en'] }],
};

function device(schema?: object): GenerativeModel {
  return getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_ON_DEVICE,
    onDeviceParams: {
      createOptions: deviceInputs as never,
      ...(schema ? { promptOptions: { responseConstraint: schema } } : {}),
    },
  });
}

function cloud(json = false): GenerativeModel {
  return getGenerativeModel(ai, {
    mode: InferenceMode.ONLY_IN_CLOUD,
    inCloudParams: {
      model: settings.cloudModel,
      generationConfig: json ? { responseMimeType: 'application/json', temperature: 0.2 } : { temperature: 0.3 },
    },
  });
}

/** Start the on-device model download (needs a user gesture). */
export async function warmUp(onProgress: (p: number) => void): Promise<void> {
  await device().initializeDeviceModel?.(onProgress);
}

export const cloudAvailable = () => configured && settings.cloudEnabled;

// ---------- shapes ----------
export interface PersonalItem {
  text: string;
  kind: string;
}

export interface Explanation {
  kind: string;
  from: string;
  summary: string;
  actions: { what: string; when: string }[];
  money: { amount: string; what: string }[];
  dates: { date: string; what: string }[];
  watch_out: string[];
}

const PERSONAL_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          kind: { type: 'string', enum: ['name', 'address', 'id', 'phone', 'email', 'account', 'dob', 'other'] },
        },
        required: ['text', 'kind'],
      },
    },
  },
  required: ['items'],
};

const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string' },
    from: { type: 'string' },
    summary: { type: 'string' },
    actions: { type: 'array', items: { type: 'object', properties: { what: { type: 'string' }, when: { type: 'string' } }, required: ['what', 'when'] } },
    money: { type: 'array', items: { type: 'object', properties: { amount: { type: 'string' }, what: { type: 'string' } }, required: ['amount', 'what'] } },
    dates: { type: 'array', items: { type: 'object', properties: { date: { type: 'string' }, what: { type: 'string' } }, required: ['date', 'what'] } },
    watch_out: { type: 'array', items: { type: 'string' } },
  },
  required: ['kind', 'from', 'summary', 'actions', 'money', 'dates', 'watch_out'],
};

function parseJson<T>(raw: string): T {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  return JSON.parse(s) as T;
}

const clip = (text: string) => (text.length > settings.maxDeviceChars ? text.slice(0, settings.maxDeviceChars) : text);

// ---------- on-device ----------

/** Read the text in a photo or screenshot, on the device. */
export async function transcribe(image: { data: string; mimeType: string }): Promise<string> {
  const r = await device().generateContent([
    'Transcribe all the text in this image exactly as written, keeping the line breaks. Output only the text, nothing else.',
    { type: 'inlineData', inlineData: image },
  ]);
  return r.response.text().trim();
}

/** Ask Gemini Nano which parts of the text identify a person. */
export async function findPersonal(text: string): Promise<PersonalItem[]> {
  const prompt = `Find every piece of personal information in the document below that identifies a specific person or household.
Include: full names of people, home or postal addresses, ID numbers (patient ID, customer ID, consumer or service connection numbers, policy numbers, reference numbers tied to a person), phone numbers, email addresses, bank account numbers, dates of birth.
Do NOT include: company, bank, hospital or government names; money amounts; test names or results; general dates; clause numbers.
Copy each item exactly as it appears. Return JSON.

DOCUMENT:
"""
${clip(text)}
"""`;
  const r = await device(PERSONAL_SCHEMA).generateContent(prompt);
  const parsed = parseJson<{ items: PersonalItem[] }>(r.response.text());
  return (parsed.items || []).filter((i) => i && typeof i.text === 'string' && text.includes(i.text.trim()));
}

const EXPLAIN_RULES = `You explain documents to someone who is not an expert and may be worried.
Use plain, everyday words and short sentences. Never invent facts that are not in the document.
- kind: what type of document this is, in a few words (for example "Bank KYC reminder").
- from: who sent it or who wrote it.
- summary: 2 to 3 short sentences on what it means for the reader.
- actions: what the reader needs to do, each with a deadline in "when" (or "No deadline given").
- money: every amount that matters to the reader and what it is for.
- dates: important dates and why they matter.
- watch_out: things the reader could easily miss, risks, or unfair terms. Empty if none.
For medical reports, explain what values outside the range might mean in general terms and suggest discussing with a doctor. Do not diagnose.`;

/** Plain-language explanation, made on the device with the full text. */
export async function explainOnDevice(text: string): Promise<Explanation> {
  const r = await device(EXPLAIN_SCHEMA).generateContent(`${EXPLAIN_RULES}\nReturn JSON.\n\nDOCUMENT:\n"""\n${clip(text)}\n"""`);
  return normaliseExplanation(parseJson<Explanation>(r.response.text()));
}

/** Answer a question privately, using the full document, on the device. */
export async function askOnDevice(text: string, question: string): Promise<string> {
  const r = await device().generateContent(
    `Answer the question using only the document. Be brief and plain. If the document doesn't say, say so.\n\nDOCUMENT:\n"""\n${clip(text)}\n"""\n\nQUESTION: ${question}`,
  );
  return r.response.text().trim();
}

// ---------- cloud (redacted input only) ----------

/** Explanation from the cloud, used when the device model isn't available. Input must be redacted. */
export async function explainInCloud(redactedText: string, language: string): Promise<Explanation> {
  const r = await cloud(true).generateContent(
    `${EXPLAIN_RULES}
Personal details have been replaced with placeholders like [NAME 1] or [ACCOUNT 1]. Keep placeholders exactly as they are; never guess what they hide.
Write every text value in ${language}. Return JSON with keys kind, from, summary, actions[{what,when}], money[{amount,what}], dates[{date,what}], watch_out[].

DOCUMENT:
"""
${redactedText}
"""`,
  );
  return normaliseExplanation(parseJson<Explanation>(r.response.text()));
}

/** Translate an explanation. Input must already be redacted. */
export async function translateInCloud(redacted: Explanation, language: string): Promise<Explanation> {
  const r = await cloud(true).generateContent(
    `Translate every text value in this JSON into ${language}, in simple everyday words that a non-expert would use. Keep the same keys and structure. Keep placeholders like [NAME 1] exactly as they are. Keep numbers, amounts and dates accurate. Return only JSON.

${JSON.stringify(redacted)}`,
  );
  return normaliseExplanation(parseJson<Explanation>(r.response.text()));
}

/** Deeper question, answered in the cloud from the redacted document. */
export async function askInCloud(redactedText: string, question: string, language: string): Promise<string> {
  const r = await cloud().generateContent(
    `You help people understand documents. Personal details are replaced with placeholders like [NAME 1]; keep them as they are and never guess what they hide.
Answer in ${language}, in plain words, in at most 120 words. Use general knowledge to explain terms and what the reader can do, but don't invent facts about this document. For medical or legal matters, give general information and suggest asking a professional.

DOCUMENT:
"""
${redactedText}
"""

QUESTION: ${question}`,
  );
  return r.response.text().trim();
}

/** Quick question in hybrid mode: on the device when possible, cloud otherwise. Input must be redacted. */
export async function askHybrid(redactedText: string, question: string): Promise<{ text: string; where: string }> {
  const m = getGenerativeModel(ai, { mode: InferenceMode.PREFER_ON_DEVICE, inCloudParams: { model: settings.cloudModel } });
  const r = await m.generateContent(`Answer briefly using only this document (personal details are hidden as placeholders):\n"""\n${redactedText}\n"""\nQUESTION: ${question}`);
  return { text: r.response.text().trim(), where: r.response.inferenceSource ?? 'unknown' };
}

function normaliseExplanation(e: Partial<Explanation>): Explanation {
  const arr = <T,>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
  return {
    kind: String(e.kind ?? ''),
    from: String(e.from ?? ''),
    summary: String(e.summary ?? ''),
    actions: arr<{ what: string; when: string }>(e.actions).filter((a) => a && a.what),
    money: arr<{ amount: string; what: string }>(e.money).filter((a) => a && a.amount),
    dates: arr<{ date: string; what: string }>(e.dates).filter((a) => a && a.date),
    watch_out: arr<string>(e.watch_out).filter((s) => typeof s === 'string' && s.trim()),
  };
}

/** Apply a string transform to every text field (used to redact/restore explanations). */
export function mapExplanation(e: Explanation, f: (s: string) => string): Explanation {
  return {
    kind: f(e.kind),
    from: f(e.from),
    summary: f(e.summary),
    actions: e.actions.map((a) => ({ what: f(a.what), when: f(a.when) })),
    money: e.money.map((a) => ({ amount: f(a.amount), what: f(a.what) })),
    dates: e.dates.map((a) => ({ date: f(a.date), what: f(a.what) })),
    watch_out: e.watch_out.map(f),
  };
}
