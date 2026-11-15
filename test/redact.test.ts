import { describe, it, expect } from 'vitest';
import { ruleSpans, aiSpans, mergeSpans, redact, restore, redactWith, verhoeff, luhn } from '../src/redact';
import { SAMPLES } from '../src/samples';

const kinds = (text: string) => ruleSpans(text).map((s) => `${s.kind}:${s.text}`);

describe('checksums', () => {
  it('verhoeff accepts a valid Aadhaar-style number and rejects a changed digit', () => {
    expect(verhoeff('738291045623')).toBe(true);
    expect(verhoeff('738291045624')).toBe(false);
  });
  it('luhn', () => {
    expect(luhn('4111111111111111')).toBe(true);
    expect(luhn('4111111111111112')).toBe(false);
  });
});

describe('rules', () => {
  it('finds Indian identifiers', () => {
    const k = kinds('Aadhaar 7382 9104 5623, PAN ABCPR1234K, IFSC SUNR0004521, call +91 98480 22317');
    expect(k).toContain('aadhaar:7382 9104 5623');
    expect(k).toContain('pan:ABCPR1234K');
    expect(k).toContain('ifsc:SUNR0004521');
    expect(k.some((x) => x.startsWith('phone:') && x.includes('98480 22317'))).toBe(true);
  });
  it('tells email and UPI apart', () => {
    const k = kinds('mail reports@citycarelabs.example or pay suresh.gupta@okhdfcbank.');
    expect(k).toContain('email:reports@citycarelabs.example');
    expect(k).toContain('upi:suresh.gupta@okhdfcbank');
    expect(k.filter((x) => x.startsWith('upi:')).length).toBe(1);
  });
  it('finds labelled names, account numbers and dates of birth', () => {
    const k = kinds('Patient Name: Priya Sharma  DOB: 14/03/1992\nSavings A/c No. 50100234567812');
    expect(k).toContain('name:Priya Sharma');
    expect(k).toContain('dob:14/03/1992');
    expect(k).toContain('account:50100234567812');
  });
  it('leaves money and lab values alone', () => {
    const k = kinds('Total payable: ₹6,100.00. Haemoglobin 10.4 g/dL. Rs. 1,20,000/- deposit. 118 mg/dL');
    expect(k).toEqual([]);
  });
  it('a random 12-digit number is not Aadhaar unless the checksum or a label says so', () => {
    expect(kinds('Order 738291045624 shipped').some((x) => x.startsWith('aadhaar'))).toBe(false);
    expect(kinds('Aadhaar no 738291045624').some((x) => x.startsWith('aadhaar'))).toBe(true);
  });
});

describe('redaction round trip', () => {
  it('uses stable placeholders and restores them on the device', () => {
    const text = 'Dear Mr. Ravi Kumar Reddy, your PAN ABCPR1234K. Ravi Kumar Reddy must visit.';
    const spans = [...ruleSpans(text), ...aiSpans(text, [{ text: 'Ravi Kumar Reddy', kind: 'name' }])];
    const r = redact(text, spans);
    expect(r.text).toBe('Dear Mr. [NAME 1], your PAN [PAN 1]. [NAME 1] must visit.');
    expect(r.text).not.toContain('Ravi');
    expect(restore('[NAME 1] should update KYC; PAN [PAN 1] is fine.', r.map)).toBe('Ravi Kumar Reddy should update KYC; PAN ABCPR1234K is fine.');
  });
  it('skips values the user chose to keep', () => {
    const text = 'Tenant: Ananya Iyer, phone 9876543210';
    const r = redact(text, ruleSpans(text), new Set(['9876543210']));
    expect(r.text).toContain('9876543210');
    expect(r.text).toContain('[NAME 1]');
  });
  it('redactWith hides known values inside new text (like a local summary)', () => {
    const map = new Map([['[NAME 1]', 'Priya Sharma'], ['[ID NUMBER 1]', 'CCD-55102']]);
    const out = redactWith('priya  sharma (CCD-55102) should repeat HbA1c. Call 9876543210.', map);
    expect(out).toBe('[NAME 1] ([ID NUMBER 1]) should repeat HbA1c. Call [HIDDEN].');
  });
  it('ignores ordinary dates and amounts the model over-flags', () => {
    const text = 'Due date 25/10/2026, pay ₹4,860.00. DOB 14/03/1992';
    const s = aiSpans(text, [{ text: '25/10/2026', kind: 'other' }, { text: '₹4,860.00', kind: 'other' }, { text: '14/03/1992', kind: 'dob' }]);
    expect(s.map((x) => x.text)).toEqual(['14/03/1992']);
  });
  it('a rule inside a longer AI span gives it the precise kind', () => {
    const text = 'Pay to suresh.gupta@okhdfcbank.';
    const spans = mergeSpans([...ruleSpans(text), ...aiSpans(text, [{ text: 'suresh.gupta@okhdfcbank.', kind: 'email' }])]);
    expect(spans.length).toBe(1);
    expect(spans[0].kind).toBe('upi');
  });
  it('overlapping rule and AI spans merge into one', () => {
    const text = 'Address: Flat 304, Lakshmi Residency, Hyderabad 500072';
    const spans = mergeSpans([...ruleSpans(text), ...aiSpans(text, [{ text: 'Flat 304, Lakshmi Residency, Hyderabad 500072', kind: 'address' }])]);
    expect(spans.length).toBe(1);
    expect(spans[0].kind).not.toBe('other');
  });
});

describe('samples', () => {
  it('the rules alone catch the structured identifiers in every sample', () => {
    const bank = redact(SAMPLES[0].text, ruleSpans(SAMPLES[0].text)).text;
    for (const secret of ['7382 9104 5623', 'ABCPR1234K', '50100234567812', '98480 22317', 'Ravi Kumar Reddy']) expect(bank).not.toContain(secret);
    const rent = redact(SAMPLES[2].text, ruleSpans(SAMPLES[2].text)).text;
    for (const secret of ['AKLPI5521Q', '9876543210', 'suresh.gupta@okhdfcbank', 'Suresh Gupta', 'Ananya Iyer']) expect(rent).not.toContain(secret);
    expect(rent).toContain('1,20,000');
    expect(rent).not.toContain('Green Park Extension');
    expect(redact(SAMPLES[3].text, ruleSpans(SAMPLES[3].text)).text).not.toContain('Yousufguda');
    const power = redact(SAMPLES[3].text, ruleSpans(SAMPLES[3].text)).text;
    expect(power).not.toContain('K. Venkatesh');
    expect(power).toContain('₹6,100.00');
  });
});
