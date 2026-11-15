import './style.css';
import { SAMPLES, type Sample } from './samples';
import { ruleSpans, aiSpans, mergeSpans, redact, restore, redactWith, KIND_LABEL, type Span, type Redaction, type Kind } from './redact';
import {
  deviceState,
  warmUp,
  transcribe,
  findPersonal,
  explainOnDevice,
  explainInCloud,
  translateInCloud,
  askOnDevice,
  askInCloud,
  cloudAvailable,
  mapExplanation,
  type Explanation,
  type DeviceState,
} from './ai';
import { configured, loadSettings, saveDoc, listDocs, deleteSaved, type SavedDoc } from './firebase';
import { LANG_CODES, onDeviceTranslation, translateOnDevice, speak } from './translate';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ---------- state ----------
let device: DeviceState = 'unsupported';
let docText = '';
let docTitle = '';
let spans: Span[] = [];
const kept = new Set<string>();
let red: Redaction = { text: '', map: new Map(), count: 0 };
let explanation: Explanation | null = null; // in English, with real values (never leaves the device)
let shown: { exp: Explanation; lang: string; where: 'device' | 'cloud'; sent?: string; how?: string } | null = null;
let image: { data: string; mimeType: string; url: string } | null = null;
let busy = false;

const LANGS = ['English', 'हिन्दी (Hindi)', 'తెలుగు (Telugu)', 'தமிழ் (Tamil)', 'ಕನ್ನಡ (Kannada)', 'മലയാളം (Malayalam)', 'मराठी (Marathi)', 'বাংলা (Bengali)', 'ગુજરાતી (Gujarati)', 'ਪੰਜਾਬੀ (Punjabi)', 'اردو (Urdu)', 'Español'];

// ---------- device status ----------
async function refreshDevice() {
  device = await deviceState();
  const pill = $('#device');
  const map: Record<DeviceState, [string, string]> = {
    available: ['ok', 'On-device AI ready'],
    downloadable: ['warn', 'On-device AI not downloaded'],
    downloading: ['warn', 'On-device AI downloading…'],
    unavailable: ['bad', 'On-device AI unavailable'],
    unsupported: ['bad', 'On-device AI not supported in this browser'],
  };
  const [cls, label] = map[device];
  pill.className = `pill ${cls}`;
  pill.innerHTML = `<i></i>${label}`;
  $('#device-help').hidden = device === 'available';
  $('#btn-download').hidden = !(device === 'downloadable' || device === 'downloading');
}

// ---------- input ----------
function setImage(data: string, mimeType: string) {
  image = { data, mimeType, url: `data:${mimeType};base64,${data}` };
  $('#photo-preview').innerHTML = `<img src="${image.url}" alt="Your photo"><button class="link" id="photo-clear">Remove</button>`;
  $('#photo-clear').onclick = () => {
    image = null;
    $('#photo-preview').innerHTML = '';
  };
  $<HTMLTextAreaElement>('#paste').value = '';
}

async function fileToImage(file: File): Promise<{ data: string; mimeType: string }> {
  // Downscale large photos; the on-device model only takes JPEG and PNG.
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.9);
  return { data: url.split(',')[1], mimeType: 'image/jpeg' };
}

/** Render a sample as a photo of a printed page, to show the image path. */
function sampleAsPhoto(s: Sample): { data: string; mimeType: string } {
  const lines = s.text.split('\n');
  const c = document.createElement('canvas');
  const w = 1100;
  const lh = 30;
  c.width = w;
  c.height = 90 + lines.length * lh;
  const g = c.getContext('2d')!;
  g.fillStyle = '#d9d4c7';
  g.fillRect(0, 0, c.width, c.height);
  g.save();
  g.translate(c.width / 2, c.height / 2);
  g.rotate(-0.008);
  g.translate(-c.width / 2, -c.height / 2);
  g.fillStyle = '#fbfaf6';
  g.shadowColor = 'rgba(0,0,0,0.25)';
  g.shadowBlur = 18;
  g.fillRect(24, 20, c.width - 48, c.height - 40);
  g.shadowBlur = 0;
  g.fillStyle = '#1d1d1f';
  g.font = '21px "Courier New", monospace';
  lines.forEach((ln, i) => g.fillText(ln, 60, 70 + i * lh));
  g.restore();
  const url = c.toDataURL('image/png');
  return { data: url.split(',')[1], mimeType: 'image/png' };
}

// ---------- run ----------
function steps(list: string[], active: number, note = '') {
  $('#steps').hidden = false;
  $('#steps').innerHTML =
    list.map((s, i) => `<li class="${i < active ? 'done' : i === active ? 'now' : ''}">${i < active ? '✓' : i === active ? '<span class="spin"></span>' : '·'} ${esc(s)}</li>`).join('') +
    (note ? `<p class="small muted">${esc(note)}</p>` : '');
}

async function run() {
  if (busy) return;
  const pasted = $<HTMLTextAreaElement>('#paste').value.trim();
  if (!image && !pasted) {
    toast('Add a photo or paste some text first.');
    return;
  }
  if (device !== 'available' && !cloudAvailable()) {
    toast('This needs Chrome’s on-device AI (or a configured Firebase project for the cloud).');
    return;
  }
  busy = true;
  $<HTMLButtonElement>('#btn-run').disabled = true;
  kept.clear();
  explanation = null;
  shown = null;
  $('#start').hidden = true;
  $('#work').hidden = false;
  $('#answers').innerHTML = '';
  $('#explain').innerHTML = '';
  $('#doc').innerHTML = '';
  const list = [image ? 'Reading your photo, on this device' : 'Reading your text', 'Finding personal details, on this device', device === 'available' ? 'Explaining in plain words, on this device' : 'Explaining in plain words (cloud, redacted copy only)'];
  try {
    steps(list, 0);
    docText = image ? await transcribe(image) : pasted;
    if (!docText) throw new Error('No text found in the photo.');
    steps(list, 1);
    spans = ruleSpans(docText);
    renderDoc();
    if (device === 'available') {
      try {
        spans = mergeSpans([...spans, ...aiSpans(docText, await findPersonal(docText))]);
      } catch (e) {
        console.warn('[plainly] on-device detection failed; using rules only', e);
      }
    }
    renderDoc();
    steps(list, 2);
    if (device === 'available') {
      explanation = await explainOnDevice(docText);
      shown = { exp: explanation, lang: 'English', where: 'device' };
    } else {
      const sent = red.text;
      const exp = await explainInCloud(sent, 'English');
      explanation = mapExplanation(exp, (s) => restore(s, red.map));
      shown = { exp: explanation, lang: 'English', where: 'cloud', sent };
    }
    docTitle = explanation.kind || 'Document';
    $('#steps').hidden = true;
    renderExplanation();
  } catch (e) {
    console.error(e);
    steps(list, -1, `Something went wrong: ${(e as Error).message}`);
  } finally {
    busy = false;
    $<HTMLButtonElement>('#btn-run').disabled = false;
  }
}

// ---------- document view ----------
function renderDoc() {
  red = redact(docText, spans, kept);
  const merged = mergeSpans(spans);
  let html = '';
  let pos = 0;
  for (const s of merged) {
    const isKept = kept.has(norm(s.text));
    html += esc(docText.slice(pos, s.start));
    html += `<mark class="${isKept ? 'kept' : ''}" data-v="${esc(s.text)}" title="${isKept ? 'Kept: will be shared' : `Hidden as ${KIND_LABEL[s.kind as Kind]}: click to keep`}">${esc(s.text)}<sup>${esc(KIND_LABEL[s.kind as Kind])}</sup></mark>`;
    pos = s.end;
  }
  html += esc(docText.slice(pos));
  $('#doc').innerHTML = html;
  $('#cloud-view').innerHTML = esc(red.text).replace(/\[([A-Z][A-Z ]*? \d+|HIDDEN)\]/g, '<span class="ph">[$1]</span>');
  const n = red.count;
  $('#hidden-count').innerHTML = `<b>${n}</b> personal detail${n === 1 ? '' : 's'} hidden${kept.size ? `, ${kept.size} kept` : ''}. Click a highlight to keep or hide it.`;
  for (const m of document.querySelectorAll<HTMLElement>('#doc mark')) {
    m.onclick = () => {
      const v = norm(m.dataset.v || '');
      if (kept.has(v)) kept.delete(v);
      else kept.add(v);
      renderDoc();
    };
  }
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

// ---------- explanation ----------
function badge(where: 'device' | 'cloud', sent?: string) {
  if (where === 'device') return `<span class="badge dev">🔒 Made on this device</span>`;
  return `<span class="badge cloud">☁️ Gemini in the cloud · saw only the redacted copy</span>${sent ? `<details class="sent"><summary>See exactly what was sent</summary><pre>${esc(sent)}</pre></details>` : ''}`;
}

function renderExplanation() {
  if (!shown) return;
  const e = shown.exp;
  const list = <T,>(items: T[], f: (x: T) => string, empty: string) => (items.length ? `<ul>${items.map((x) => `<li>${f(x)}</li>`).join('')}</ul>` : `<p class="muted small">${empty}</p>`);
  $('#explain').innerHTML = `
    <div class="exp-head">
      <div><p class="eyebrow">${esc(e.from || 'Document')}</p><h2>${esc(e.kind || 'Your document')}</h2></div>
      <div class="head-right">${shown.how ? `<span class="badge dev">🔒 ${esc(shown.how)}</span>` : badge(shown.where, shown.sent)}
      <button id="btn-speak" class="ghost small-btn">🔊 Read aloud</button></div>
    </div>
    <section class="card lead"><h3>In plain words</h3><p>${esc(e.summary)}</p></section>
    <section class="card"><h3>What you need to do</h3>${list(e.actions, (a) => `<b>${esc(a.what)}</b><span class="when">${esc(a.when)}</span>`, 'Nothing you need to do.')}</section>
    <div class="two">
      <section class="card"><h3>Money</h3>${list(e.money, (m) => `<b>${esc(m.amount)}</b> ${esc(m.what)}`, 'No amounts mentioned.')}</section>
      <section class="card"><h3>Dates</h3>${list(e.dates, (d) => `<b>${esc(d.date)}</b> ${esc(d.what)}`, 'No dates mentioned.')}</section>
    </div>
    ${e.watch_out.length ? `<section class="card warn"><h3>Watch out for</h3>${list(e.watch_out, (w) => esc(w), '')}</section>` : ''}
  `;
  $<HTMLSelectElement>('#lang').value = shown.lang;
  $('#btn-speak').onclick = () => {
    const e2 = shown!.exp;
    const text = [e2.kind, e2.summary, ...e2.actions.map((a) => `${a.what}. ${a.when}.`), ...e2.watch_out].join('. ');
    if (!speak(text, LANG_CODES[shown!.lang] || 'en')) toast(`No ${shown!.lang} voice is installed on this device.`);
  };
  $('#lang-note').textContent = '';
  $('#save-row').hidden = !configured;
}

async function translate(lang: string) {
  if (!explanation) return;
  if (lang === 'English') {
    shown = { exp: explanation, lang, where: device === 'available' ? 'device' : 'cloud' };
    renderExplanation();
    return;
  }
  const code = LANG_CODES[lang] || 'en';
  // 1. On-device first: Chrome's built-in Translator keeps even the real details on this computer.
  const local = await onDeviceTranslation(code);
  if (local !== 'unavailable') {
    $('#lang-note').innerHTML = `<span class="spin"></span> Translating on this device…`;
    try {
      const fields: string[] = [];
      mapExplanation(explanation, (s) => (fields.push(s), s));
      const out = await translateOnDevice(code, fields, (p) => ($('#lang-note').innerHTML = `<span class="spin"></span> Getting the ${lang} model for this device… ${Math.round(p * 100)}%`));
      let i = 0;
      shown = { exp: mapExplanation(explanation, () => out[i++]), lang, where: 'device', how: 'Translated on this device with Chrome’s built-in Translator' };
      renderExplanation();
      return;
    } catch (e) {
      console.warn('[plainly] on-device translation failed, falling back to the cloud', e);
    }
  }
  // 2. Cloud fallback: Gemini sees only the redacted explanation; real details are restored here.
  if (!cloudAvailable()) {
    $('#lang-note').textContent = `${lang} isn’t available on this device, and the cloud needs the Firebase setup (see README).`;
    return;
  }
  $('#lang-note').innerHTML = `<span class="spin"></span> ${lang} isn’t on this device, so Gemini in the cloud is translating. It gets only the redacted version.`;
  try {
    const redacted = mapExplanation(explanation, (s) => redactWith(s, red.map));
    const out = await translateInCloud(redacted, lang);
    shown = { exp: mapExplanation(out, (s) => restore(s, red.map)), lang, where: 'cloud', sent: JSON.stringify(redacted, null, 2) };
    renderExplanation();
  } catch (e) {
    $('#lang-note').textContent = `Couldn’t translate: ${(e as Error).message}`;
  }
}

// ---------- questions ----------
async function ask(where: 'device' | 'cloud') {
  const input = $<HTMLInputElement>('#q');
  const q = input.value.trim();
  if (!q || !docText) return;
  input.value = '';
  const lang = $<HTMLSelectElement>('#lang').value;
  const li = document.createElement('div');
  li.className = 'answer';
  li.innerHTML = `<p class="q">${esc(q)}</p><p class="a"><span class="spin"></span> ${where === 'device' ? 'Thinking on this device…' : 'Asking Gemini in the cloud (redacted copy)…'}</p>`;
  $('#answers').prepend(li);
  try {
    let text: string;
    let sent: string | undefined;
    if (where === 'device') {
      text = await askOnDevice(docText, q);
    } else {
      sent = `${red.text}\n\nQUESTION: ${redactWith(q, red.map)}`;
      text = restore(await askInCloud(red.text, redactWith(q, red.map), lang), red.map);
    }
    li.innerHTML = `<p class="q">${esc(q)}</p><p class="a">${esc(text).replace(/\n/g, '<br>')}</p>${badge(where, sent)}`;
  } catch (e) {
    li.querySelector('.a')!.textContent = `Couldn’t answer: ${(e as Error).message}`;
  }
}

// ---------- history ----------
async function save() {
  if (!explanation) return;
  const btn = $<HTMLButtonElement>('#btn-save');
  btn.disabled = true;
  try {
    await saveDoc({
      title: redactWith(docTitle, red.map),
      redactedText: red.text,
      explanation: mapExplanation(explanation, (s) => redactWith(s, red.map)),
      hidden: red.count,
    });
    btn.textContent = 'Saved (redacted)';
  } catch (e) {
    btn.disabled = false;
    toast(`Couldn’t save: ${(e as Error).message}`);
  }
}

async function openHistory() {
  const dlg = $<HTMLDialogElement>('#history');
  const body = $('#history-list');
  body.innerHTML = '<p class="muted"><span class="spin"></span> Loading…</p>';
  dlg.showModal();
  if (!configured) {
    body.innerHTML = '<p class="muted">History needs the Firebase setup (see README). Nothing is stored in local-only mode.</p>';
    return;
  }
  try {
    const docs = await listDocs();
    if (!docs.length) {
      body.innerHTML = '<p class="muted">Nothing saved yet.</p>';
      return;
    }
    body.innerHTML = docs
      .map(
        (d: SavedDoc) => `<div class="hist"><div><b>${esc(d.title)}</b><p class="small muted">${d.hidden} details hidden · stored without them</p>
      <details><summary class="small">What’s stored</summary><pre>${esc(d.redactedText)}</pre></details></div><button class="link" data-del="${d.id}">Delete</button></div>`,
      )
      .join('');
    for (const b of body.querySelectorAll<HTMLButtonElement>('[data-del]')) {
      b.onclick = async () => {
        await deleteSaved(b.dataset.del!);
        b.closest('.hist')?.remove();
      };
    }
  } catch (e) {
    body.innerHTML = `<p class="muted">Couldn’t load history: ${esc((e as Error).message)}</p>`;
  }
}

// ---------- misc ----------
function toast(msg: string) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout((t as unknown as { _t: number })._t);
  (t as unknown as { _t: number })._t = window.setTimeout(() => (t.hidden = true), 3500);
}

function reset() {
  $('#work').hidden = true;
  $('#start').hidden = false;
  docText = '';
  explanation = null;
  window.scrollTo({ top: 0 });
}

function wire() {
  $('#samples').innerHTML = SAMPLES.map(
    (s) => `<button class="sample" data-id="${s.id}"><b>${esc(s.title)}</b><span>${esc(s.blurb)}${s.asPhoto ? ' · as a photo' : ''}</span></button>`,
  ).join('');
  for (const b of document.querySelectorAll<HTMLButtonElement>('.sample')) {
    b.onclick = () => {
      const s = SAMPLES.find((x) => x.id === b.dataset.id)!;
      if (s.asPhoto) {
        const img = sampleAsPhoto(s);
        setImage(img.data, img.mimeType);
      } else {
        image = null;
        $('#photo-preview').innerHTML = '';
        $<HTMLTextAreaElement>('#paste').value = s.text;
      }
      run();
    };
  }
  const file = $<HTMLInputElement>('#file');
  file.onchange = async () => {
    const f = file.files?.[0];
    if (!f) return;
    const img = await fileToImage(f);
    setImage(img.data, img.mimeType);
  };
  const drop = $('#drop');
  drop.ondragover = (e) => {
    e.preventDefault();
    drop.classList.add('over');
  };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer?.files?.[0];
    if (f && /image\/(png|jpe?g)/.test(f.type)) {
      const img = await fileToImage(f);
      setImage(img.data, img.mimeType);
    } else toast('Use a JPEG or PNG photo or screenshot.');
  };
  $<HTMLTextAreaElement>('#paste').oninput = () => {
    if ($<HTMLTextAreaElement>('#paste').value) {
      image = null;
      $('#photo-preview').innerHTML = '';
    }
  };
  $('#btn-run').onclick = run;
  $('#btn-new').onclick = reset;
  $('#btn-download').onclick = async () => {
    $('#btn-download').textContent = 'Downloading… 0%';
    try {
      await warmUp((p) => ($('#btn-download').textContent = `Downloading… ${Math.round(p * 100)}%`));
    } catch (e) {
      toast(`Download failed: ${(e as Error).message}`);
    }
    refreshDevice();
  };
  $('#lang').innerHTML = LANGS.map((l) => `<option>${l}</option>`).join('');
  $<HTMLSelectElement>('#lang').onchange = (e) => translate((e.target as HTMLSelectElement).value);
  $('#ask-device').onclick = () => ask('device');
  $('#ask-cloud').onclick = () => ask('cloud');
  $<HTMLInputElement>('#q').onkeydown = (e) => {
    if (e.key === 'Enter') ask(device === 'available' ? 'device' : 'cloud');
  };
  $('#btn-save').onclick = save;
  $('#btn-history').onclick = openHistory;
  for (const t of document.querySelectorAll<HTMLButtonElement>('.view-tab')) {
    t.onclick = () => {
      for (const o of document.querySelectorAll('.view-tab')) o.classList.toggle('on', o === t);
      $('#doc').hidden = t.dataset.view !== 'doc';
      $('#cloud-view').hidden = t.dataset.view !== 'cloud';
    };
  }
  if (!cloudAvailable()) {
    $('#ask-cloud').setAttribute('disabled', '');
    $('#ask-cloud').title = 'Needs the Firebase setup';
  }
}

wire();
loadSettings().then(() => {
  if (!cloudAvailable()) $('#ask-cloud').setAttribute('disabled', '');
  else $('#ask-cloud').removeAttribute('disabled');
});
refreshDevice();
