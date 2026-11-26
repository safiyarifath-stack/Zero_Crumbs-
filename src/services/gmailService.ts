import {
  GoogleAuthProvider,
  linkWithPopup,
  onAuthStateChanged,
  reauthenticateWithPopup,
  signInWithPopup,
  type User,
} from 'firebase/auth';
import { auth } from '../firebase';

// Least-privilege scope: Gmail is connected ONLY to send verification OTP emails.
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
] as const;

// Strictly in-memory OAuth access token cache (never stored in localStorage/sessionStorage)
let cachedGmailAccessToken: string | null = null;
let cachedGmailUid: string | null = null;
const tokenListeners = new Set<(connected: boolean) => void>();

function notifyTokenListeners() {
  const connected = Boolean(cachedGmailAccessToken && auth.currentUser?.uid === cachedGmailUid);
  tokenListeners.forEach((cb) => cb(connected));
}

onAuthStateChanged(auth, (user) => {
  if (!user || user.uid !== cachedGmailUid) {
    cachedGmailAccessToken = null;
    cachedGmailUid = null;
    notifyTokenListeners();
  }
});

export function subscribeGmailConnection(callback: (connected: boolean) => void): () => void {
  tokenListeners.add(callback);
  callback(Boolean(cachedGmailAccessToken && auth.currentUser?.uid === cachedGmailUid));
  return () => {
    tokenListeners.delete(callback);
  };
}

export function setCachedGmailAccessToken(user: User | null, accessToken: string | null | undefined) {
  if (user && accessToken && accessToken.trim()) {
    cachedGmailAccessToken = accessToken.trim();
    cachedGmailUid = user.uid;
  } else {
    cachedGmailAccessToken = null;
    cachedGmailUid = null;
  }
  notifyTokenListeners();
}

export function clearGmailAccessToken() {
  cachedGmailAccessToken = null;
  cachedGmailUid = null;
  notifyTokenListeners();
}

export function getGmailAccessToken(): string | null {
  if (!auth.currentUser || auth.currentUser.uid !== cachedGmailUid) {
    return null;
  }
  return cachedGmailAccessToken;
}

export function buildGmailGoogleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  for (const scope of GMAIL_SCOPES) {
    provider.addScope(scope);
  }
  provider.setCustomParameters({
    prompt: 'consent select_account',
    include_granted_scopes: 'true',
  });
  return provider;
}

export async function connectGmailForOtpWithGoogle(): Promise<{
  email: string;
  accessToken: string;
}> {
  const provider = buildGmailGoogleProvider();
  const currentUser = auth.currentUser;

  if (currentUser) {
    const hasGoogleProvider = currentUser.providerData.some((p) => p.providerId === 'google.com');
    try {
      const result = hasGoogleProvider
        ? await reauthenticateWithPopup(currentUser, provider)
        : await linkWithPopup(currentUser, provider);
      const cred = GoogleAuthProvider.credentialFromResult(result);
      if (!cred?.accessToken) {
        throw new Error(
          'Google did not return a Gmail send token. Please try again and allow Gmail send permission.'
        );
      }
      setCachedGmailAccessToken(result.user, cred.accessToken);
      return {
        email: result.user.email || '',
        accessToken: cred.accessToken,
      };
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code || '';
      if (code === 'auth/credential-already-in-use') {
        throw new Error(
          'That Google account is already linked to a separate Zero Crumbs login. Sign in with that Google account directly or pick a Google account matching your current login.'
        );
      }
      if (code === 'auth/user-mismatch') {
        throw new Error(
          `Please select your signed-in Google account (${currentUser.email || 'matching account'}) to connect Gmail for OTP verification.`
        );
      }
      throw err;
    }
  }

  const result = await signInWithPopup(auth, provider);
  const cred = GoogleAuthProvider.credentialFromResult(result);
  if (!cred?.accessToken) {
    throw new Error('Failed to retrieve Gmail send token from Google.');
  }
  setCachedGmailAccessToken(result.user, cred.accessToken);
  return {
    email: result.user.email || '',
    accessToken: cred.accessToken,
  };
}
