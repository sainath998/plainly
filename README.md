# Plainly

**Understand any document in plain words, and keep your personal details to yourself.**

Bank letters, lab reports, rental agreements and electricity notices are written for the people who send them, not for the people who get them. People then paste them into a chatbot, along with their Aadhaar number, account number, home address and medical results.

Plainly takes a photo or the text of a document and explains it **with Gemini Nano on your own device**: what it is, what you need to do and by when, the money involved, and what to watch out for. If you want more, like a translation into Telugu or Hindi or a deeper question, Plainly uses Gemini in the cloud. **The cloud only ever sees a copy with your personal details swapped for placeholders**, and its answers are filled back in on your device.

Built with **Firebase AI Logic hybrid inference** for the #BuildHybridAI 2026 hackathon (Web/Chrome).

## How it works

```
photo / text ──► [on device] Gemini Nano reads the photo (multimodal)
               ├► [on device] personal details found: Gemini Nano (JSON-constrained) + exact rules
               │              (Aadhaar with Verhoeff check, PAN, IFSC, UPI, cards with Luhn, phones, accounts…)
               ├► [on device] plain explanation (JSON-constrained): what / do / by when / money / watch out
               └► redacted copy:  "Dear Mr. [NAME 1] … A/c No. [ACCOUNT 1] … Aadhaar [AADHAAR 1]"
                        │
                        └► [cloud, only when you ask] Gemini translates or answers using placeholders
                                 └► [on device] placeholders filled back in with your real details
```

| Step | Where it runs | Firebase AI Logic mode |
|---|---|---|
| Read a photo or screenshot | Device | `ONLY_ON_DEVICE` (image input) |
| Find personal details | Device, plus deterministic rules | `ONLY_ON_DEVICE` with a `responseConstraint` JSON schema |
| Explain in plain English | Device | `ONLY_ON_DEVICE` with a `responseConstraint` JSON schema |
| Ask privately | Device, full document | `ONLY_ON_DEVICE` |
| Translate into 11 languages (Hindi, Telugu, Tamil, Kannada, Malayalam, Marathi, Bengali, Gujarati, Punjabi, Urdu, Spanish) | Cloud, redacted copy only | `ONLY_IN_CLOUD` |
| Ask Gemini a deeper question | Cloud, redacted copy only | `ONLY_IN_CLOUD` |
| No on-device model available | Rules redact, then cloud explains the redacted copy | `ONLY_IN_CLOUD` |

Private steps use `ONLY_ON_DEVICE` on purpose. If Gemini Nano isn't available, they fail instead of quietly sending the full document to the cloud.

Every answer shows where it was made (**🔒 Made on this device** or **☁️ Gemini in the cloud**). Cloud answers have a **"See exactly what was sent"** panel. The **"What the cloud would see"** tab shows the redacted copy at any time, and clicking a highlight lets you choose to keep or hide each detail.

### Firebase products used
- **Firebase AI Logic**: hybrid inference (Gemini Nano in Chrome, plus Gemini Developer API in the cloud).
- **App Check** with reCAPTCHA Enterprise protects the Gemini endpoint. A debug token is used in development.
- **Authentication**: anonymous sign-in, so each person's saved documents are their own.
- **Cloud Firestore**: "My saved documents" stores **only the redacted text and explanation**, never the real values (`users/{uid}/docs`).
- **Remote Config**: `cloud_model`, `cloud_enabled` (kill switch) and `max_device_chars` change without a redeploy.

## Run it

Requirements: desktop Chrome 139+. Turn on `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` and restart. The on-device model downloads once, about 4 GB, and the app has a button for it.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # redaction rules: checksums, Indian ID formats, round trips
```

**Local-only mode.** If no Firebase config is set, everything private still works: reading photos, redaction, explanations and private questions. Only translation, cloud questions and saved history are switched off.

**Full mode** needs a Firebase project. Copy `.env.example` to `.env` and fill it in:
1. Firebase console → create a project → **AI Logic** → Get started → **Gemini Developer API**.
2. Add a **Web app** and copy its config into `.env`.
3. **Authentication** → Sign-in method → enable **Anonymous**.
4. **Firestore** → create a database, then deploy the rules in `firestore.rules`.
5. **App Check** → register the web app with reCAPTCHA Enterprise. Put the site key in `VITE_RECAPTCHA_ENTERPRISE_KEY`. For development, set `VITE_APPCHECK_DEBUG=true` and register the debug token printed in the browser console.
6. (Optional) **Remote Config** → add `cloud_model` (default `gemini-flash-latest`), `cloud_enabled` (`true`) and `max_device_chars` (`7000`).

## Privacy, plainly
- Photos and original text are processed in the browser by Gemini Nano. They are not uploaded.
- The placeholder map (`[NAME 1]` → real name) lives only in the page's memory.
- The cloud receives only the redacted copy, and only after you click translate or "Ask Gemini".
- Saved documents contain only the redacted version.
- Rules catch structured identifiers even if the model misses them. The model catches names and addresses the rules can't. You can review and change every highlight.
- This is not legal, financial or medical advice.

## Project layout
```
src/redact.ts    rules, checksums, merging, placeholders, restore (pure, tested)
src/ai.ts        Firebase AI Logic: on-device, cloud and hybrid calls, JSON schemas
src/firebase.ts  App Check, anonymous Auth, Firestore history, Remote Config
src/main.ts      UI
src/samples.ts   fictional sample documents (one is rendered as a photo)
test/            vitest
```

All names and numbers in the samples are made up.

## License
MIT
