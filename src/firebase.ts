// Firebase wiring: app, App Check, anonymous Auth, Firestore history, Remote Config.
// Without a Firebase config (local development), the app still runs fully on
// the device; only the cloud features and saved history are switched off.

import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { getAuth, signInAnonymously, onAuthStateChanged, type User } from 'firebase/auth';
import { getFirestore, collection, addDoc, getDocs, deleteDoc, doc, query, orderBy, limit, serverTimestamp } from 'firebase/firestore';
import { getRemoteConfig, fetchAndActivate, getValue } from 'firebase/remote-config';

const env = import.meta.env;
const config = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};

export const configured = Boolean(config.apiKey && config.projectId && config.appId);

export const app = initializeApp(
  configured ? config : { apiKey: 'local-only', projectId: 'plainly-local', appId: '1:000000000000:web:local' },
);

// App Check protects the Gemini endpoint from abuse. A debug token is used in development.
if (configured) {
  if (env.VITE_APPCHECK_DEBUG === 'true') (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  if (env.VITE_RECAPTCHA_ENTERPRISE_KEY) {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(env.VITE_RECAPTCHA_ENTERPRISE_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  }
}

// ---- Remote Config: model choice and limits can change without a redeploy ----
export const settings = {
  cloudModel: 'gemini-flash-latest',
  cloudEnabled: true,
  maxDeviceChars: 7000,
};

export async function loadSettings(): Promise<void> {
  if (!configured) return;
  try {
    const rc = getRemoteConfig(app);
    rc.settings.minimumFetchIntervalMillis = 60 * 60 * 1000;
    rc.defaultConfig = {
      cloud_model: settings.cloudModel,
      cloud_enabled: settings.cloudEnabled,
      max_device_chars: settings.maxDeviceChars,
    };
    await fetchAndActivate(rc);
    settings.cloudModel = getValue(rc, 'cloud_model').asString() || settings.cloudModel;
    settings.cloudEnabled = getValue(rc, 'cloud_enabled').asBoolean();
    settings.maxDeviceChars = getValue(rc, 'max_device_chars').asNumber() || settings.maxDeviceChars;
  } catch (e) {
    console.warn('[plainly] remote config unavailable, using defaults', e);
  }
}

// ---- Auth: anonymous, only so each person's saved history is theirs ----
let user: User | null = null;
export async function ensureUser(): Promise<User | null> {
  if (!configured) return null;
  if (user) return user;
  const auth = getAuth(app);
  await new Promise<void>((resolve) => {
    const stop = onAuthStateChanged(auth, (u) => {
      user = u;
      stop();
      resolve();
    });
  });
  if (!user) user = (await signInAnonymously(auth)).user;
  return user;
}

// ---- Firestore: history holds redacted text only, never the real values ----
export interface SavedDoc {
  id?: string;
  title: string;
  redactedText: string;
  explanation: unknown;
  hidden: number;
  createdAt?: unknown;
}

export async function saveDoc(d: SavedDoc): Promise<string | null> {
  const u = await ensureUser();
  if (!u) return null;
  const ref = await addDoc(collection(getFirestore(app), 'users', u.uid, 'docs'), { ...d, createdAt: serverTimestamp() });
  return ref.id;
}

export async function listDocs(): Promise<SavedDoc[]> {
  const u = await ensureUser();
  if (!u) return [];
  const snap = await getDocs(query(collection(getFirestore(app), 'users', u.uid, 'docs'), orderBy('createdAt', 'desc'), limit(20)));
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as SavedDoc) }));
}

export async function deleteSaved(id: string): Promise<void> {
  const u = await ensureUser();
  if (!u) return;
  await deleteDoc(doc(getFirestore(app), 'users', u.uid, 'docs', id));
}
