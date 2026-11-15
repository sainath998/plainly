// Finding and hiding personal details, entirely on the device.
//
// Two layers work together:
//  1. Rules (this file): exact patterns for things that have a fixed shape,
//     such as Aadhaar, PAN, IFSC, phone, email, UPI, card and account numbers.
//  2. The on-device model (see ai.ts) adds what rules can't see, such as names
//     and addresses. Its findings are turned into spans here too.
//
// Redaction replaces each distinct value with a stable placeholder such as
// [NAME 1] or [AADHAAR 1]. The cloud model only ever sees those placeholders,
// and its answers are filled back in with the real values on the device.

export type Kind =
  | 'name'
  | 'address'
  | 'aadhaar'
  | 'pan'
  | 'ifsc'
  | 'phone'
  | 'email'
  | 'upi'
  | 'card'
  | 'account'
  | 'passport'
  | 'vehicle'
  | 'pincode'
  | 'dob'
  | 'id'
  | 'other';

export interface Span {
  start: number;
  end: number;
  kind: Kind;
  text: string;
  source: 'rule' | 'ai';
}

export const KIND_LABEL: Record<Kind, string> = {
  name: 'NAME',
  address: 'ADDRESS',
  aadhaar: 'AADHAAR',
  pan: 'PAN',
  ifsc: 'IFSC',
  phone: 'PHONE',
  email: 'EMAIL',
  upi: 'UPI ID',
  card: 'CARD',
  account: 'ACCOUNT',
  passport: 'PASSPORT',
  vehicle: 'VEHICLE',
  pincode: 'PIN CODE',
  dob: 'DATE OF BIRTH',
  id: 'ID NUMBER',
  other: 'PRIVATE',
};

// --- checksums that keep false positives down ---

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Aadhaar numbers end in a Verhoeff check digit. */
export function verhoeff(digits: string): boolean {
  let c = 0;
  const arr = digits.split('').reverse().map(Number);
  for (let i = 0; i < arr.length; i++) c = VERHOEFF_D[c][VERHOEFF_P[i % 8][arr[i]]];
  return c === 0;
}

/** Card numbers end in a Luhn check digit. */
export function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const onlyDigits = (s: string) => s.replace(/\D/g, '');

interface Rule {
  kind: Kind;
  re: RegExp;
  check?: (match: string, text: string, index: number) => boolean;
  group?: number;
}

const near = (text: string, index: number, words: RegExp, before = 40) =>
  words.test(text.slice(Math.max(0, index - before), index));

/** Case-insensitive word for use inside an otherwise case-sensitive regex. */
const ci = (w: string) => w.replace(/[a-z]/gi, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`);
const LABELS = ['name', 'patient', 'customer', 'applicant', 'tenant', 'landlord', 'borrower', 'insured', 'account holder', 'consumer', 'employee', 'student', 'beneficiary', 'nominee', 'father', 'mother', 'spouse', 'guardian'];
const TITLES = ['mr', 'mrs', 'ms', 'miss', 'dr', 'shri', 'smt', 'kum'];
const NAME_RE = new RegExp(
  '(?:\\b(?:' + LABELS.map(ci).join('|') + ")(?:'s)?[ \\t]*(?:" + ci('name') + ')?[ \\t]*[:\\-][ \\t]*' +
    '|\\b(?:' + ci('dear') + '[ \\t]+)?(?:' + TITLES.map(ci).join('|') + ')\\.?[ \\t]+' +
    '|\\b' + ci('dear') + '[ \\t]+' +
    '|\\b[SDWCsdwc]\\/[Oo][ \\t]+)' +
    "((?:[A-Z][a-zA-Z'-]*\\.?[ \\t]?){1,4})",
  'g',
);

const RULES: Rule[] = [
  { kind: 'email', re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g },
  // UPI handles look like email but have no dot in the domain: name@okaxis
  { kind: 'upi', re: /\b[\w.-]{2,}@[a-zA-Z]{2,}\b/g },
  { kind: 'pan', re: /\b[A-Z]{3}[ABCFGHLJPTK][A-Z]\d{4}[A-Z]\b/g },
  { kind: 'ifsc', re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },
  { kind: 'passport', re: /\b[A-PR-WY][1-9]\d{6}\b/g, check: (m, t, i) => near(t, i, /passport/i, 60) },
  { kind: 'vehicle', re: /\b[A-Z]{2}[ -]?\d{1,2}[ -]?[A-Z]{1,3}[ -]?\d{4}\b/g },
  // Aadhaar: 12 digits, often written 4-4-4. Masked forms like XXXX XXXX 1234 too.
  { kind: 'aadhaar', re: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g, check: (m, t, i) => verhoeff(onlyDigits(m)) || near(t, i, /aadhaa?r|uid/i) },
  { kind: 'aadhaar', re: /\b[Xx*]{4}[ -]?[Xx*]{4}[ -]?\d{4}\b/g },
  { kind: 'card', re: /\b(?:\d[ -]?){12,18}\d\b/g, check: (m) => luhn(onlyDigits(m)) && /^[3-6]/.test(onlyDigits(m)) },
  { kind: 'phone', re: /(?:\+91[ -]?|\b0)?\b[6-9]\d{4}[ -]?\d{5}\b/g },
  { kind: 'phone', re: /\+\d{1,3}[ -]?\(?\d{2,4}\)?[ -]?\d{3,4}[ -]?\d{3,4}\b/g },
  {
    kind: 'account',
    re: /\b\d[\d -]{7,20}\d\b/g,
    check: (m, t, i) => {
      const d = onlyDigits(m);
      return d.length >= 9 && d.length <= 18 && near(t, i, /a\/c|acc(oun)?t|acct|folio|policy|loan|customer id|cif|consumer|ref(erence)?|no\.?\s*$/i, 30);
    },
  },
  {
    kind: 'dob',
    re: /\b(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4})\b/gi,
    check: (m, t, i) => near(t, i, /d\.?o\.?b|date of birth|born|birth/i, 30),
  },
  { kind: 'pincode', re: /\b[1-9]\d{2}\s?\d{3}\b/g, check: (m, t, i) => near(t, i, /pin|pincode|postal|zip|[a-z]{3,},?\s*$/i, 30) && !near(t, i, /₹|rs\.?|inr|amount|total|\$/i, 12) },
  // Labelled names: "Name: Ravi Kumar", "Patient Name: ...", "Dear Mr. ...", "S/o ..."
  { kind: 'name', re: NAME_RE, group: 1 },
  // Addresses introduced by a label, up to the PIN code: "residing at 12-B, Green Park, New Delhi 110016"
  { kind: 'address', re: /(?:residing at|resident of|r\/o|address\s*[:\-])\s*([\s\S]{3,160}?\b[1-9]\d{2}\s?\d{3}\b)/gi, group: 1 },
];

/** Rule-based spans. Never leaves the device; no model needed. */
export function ruleSpans(text: string): Span[] {
  const out: Span[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text))) {
      let start = m.index;
      let value = m[0];
      if (rule.group) {
        const g = m[rule.group] || '';
        value = g.replace(/[\s.,]+$/, '');
        if (value.length < 2 || /^(Sub|Ref|Date|No|The|Your|Please)$/.test(value)) continue;
        start = m.index + m[0].lastIndexOf(g);
      }
      if (rule.check && !rule.check(value, text, start)) continue;
      if (rule.kind === 'upi' && /\.[a-z]/i.test(text.slice(start + value.length, start + value.length + 2))) continue;
      out.push({ start, end: start + value.length, kind: rule.kind, text: value, source: 'rule' });
    }
  }
  return out;
}

/** Turn strings the on-device model flagged into spans (every occurrence). */
export function aiSpans(text: string, items: { text: string; kind: string }[]): Span[] {
  const out: Span[] = [];
  const lower = text.toLowerCase();
  for (const item of items) {
    const value = (item.text || '').trim();
    if (value.length < 3 || value.length > 160) continue;
    // models sometimes "flag" generic words; skip those
    if (/^(the|patient|customer|name|address|date|bank|india|government)$/i.test(value)) continue;
    const kind = (Object.keys(KIND_LABEL) as Kind[]).includes(item.kind as Kind) ? (item.kind as Kind) : 'other';
    // Number-type details must contain a digit ("Savings A/c No." is a label, not an account).
    if (['account', 'id', 'phone', 'aadhaar', 'pan', 'card', 'pincode', 'passport', 'dob'].includes(kind) && !/\d/.test(value)) continue;
    // Ordinary dates and amounts matter for understanding the document; only birth dates are personal.
    if (kind !== 'dob' && /^(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}[ -][A-Za-z]{3,9}[ -]\d{2,4}|[A-Za-z]{3,9} \d{1,2},? \d{4})$/.test(value)) continue;
    if (/^(?:₹|rs\.?|inr|\$)?\s?[\d,]+(?:\.\d+)?\/?-?$/i.test(value) && kind !== 'account' && kind !== 'id' && kind !== 'phone') continue;
    const needle = value.toLowerCase();
    let i = lower.indexOf(needle);
    while (i >= 0) {
      out.push({ start: i, end: i + value.length, kind, text: text.slice(i, i + value.length), source: 'ai' });
      i = lower.indexOf(needle, i + value.length);
    }
  }
  return out;
}

/** Merge overlapping spans; rules win ties because their kind is precise. */
export function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end || (a.source === 'rule' ? -1 : 1));
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) {
      // a precise rule inside a fuzzy AI span lends it its kind ("email" vs "upi")
      if (s.source === 'rule' && last.source === 'ai' && s.end <= last.end) out[out.length - 1] = { ...last, kind: s.kind, source: 'rule' };
      if (s.end > last.end) {
        // extend, keep the more specific kind
        const kind = last.source === 'rule' ? last.kind : s.source === 'rule' ? s.kind : last.kind;
        out[out.length - 1] = { ...last, end: s.end, kind, text: last.text + s.text.slice(last.end - s.start) };
      }
      continue;
    }
    out.push(s);
  }
  return out;
}

export interface Redaction {
  text: string; // redacted text, safe to send
  map: Map<string, string>; // placeholder -> real value (stays on device)
  count: number;
}

/**
 * Replace spans with numbered placeholders. The same value always gets the same
 * placeholder, so the cloud model can still reason ("[NAME 1] must pay...").
 */
export function redact(text: string, spans: Span[], skip: Set<string> = new Set()): Redaction {
  const merged = mergeSpans(spans).filter((s) => !skip.has(norm(s.text)));
  const byValue = new Map<string, string>();
  const counters = new Map<Kind, number>();
  const map = new Map<string, string>();
  let out = '';
  let pos = 0;
  for (const s of merged) {
    const key = s.kind + '|' + norm(s.text);
    let ph = byValue.get(key);
    if (!ph) {
      const n = (counters.get(s.kind) || 0) + 1;
      counters.set(s.kind, n);
      ph = `[${KIND_LABEL[s.kind]} ${n}]`;
      byValue.set(key, ph);
      map.set(ph, s.text);
    }
    out += text.slice(pos, s.start) + ph;
    pos = s.end;
  }
  out += text.slice(pos);
  return { text: out, map, count: merged.length };
}

/** Put the real values back into text that came from the cloud. */
export function restore(text: string, map: Map<string, string>): string {
  return text.replace(/\[([A-Z][A-Z ]*?) (\d+)\]/g, (whole) => map.get(whole) ?? whole);
}

/** Redact a piece of text using values already found in the document. */
export function redactWith(text: string, map: Map<string, string>): string {
  let out = text;
  const entries = [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [ph, value] of entries) {
    if (!value) continue;
    const re = new RegExp(escapeRe(value).replace(/\s+/g, '\\s+'), 'gi');
    out = out.replace(re, ph);
  }
  // Anything the rules can still find (say, a number the model repeated in a
  // different format) is hidden with a generic marker.
  const leftovers = mergeSpans(ruleSpans(out)).filter((sp) => !/^\[[A-Z ]+ \d+\]$/.test(sp.text));
  for (const sp of leftovers.reverse()) out = out.slice(0, sp.start) + '[HIDDEN]' + out.slice(sp.end);
  return out;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function norm(s: string) {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}
