import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

// Mode de prova local (VITE_LOCAL_DEMO=true): no es connecta a Firebase.
export const isLocalDemo = import.meta.env.VITE_LOCAL_DEMO === 'true';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const isFirebaseConfigured = isLocalDemo || Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

const fallbackConfig = {
  apiKey: 'local-demo',
  authDomain: 'local-demo.firebaseapp.com',
  projectId: 'local-demo',
  storageBucket: 'local-demo.appspot.com',
  messagingSenderId: '000000000000',
  appId: '1:000000000000:web:localdemo',
};

const config = isLocalDemo ? fallbackConfig : firebaseConfig;
const app = initializeApp(config);
export const auth = getAuth(app);
export const db = getFirestore(app);
// Forcem els correus d'Authentication en català (si la plantilla catalana existeix, s'usa).
auth.languageCode = 'ca';

// Segon app: permet crear comptes d'alumne i de professor sense tancar la sessió actual.
const setupApp = getApps().some((item) => item.name === 'setup') ? getApp('setup') : initializeApp(config, 'setup');
export const setupAuth = getAuth(setupApp);
export const setupDb = getFirestore(setupApp);
