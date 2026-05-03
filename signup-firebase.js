import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  updateProfile,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
  setPersistence,
  browserSessionPersistence,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getAnalytics, isSupported } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-analytics.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  serverTimestamp,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyBffpkUGb2z8J1o2xp8IsnFDDt1X0yxdPI",
  authDomain: "cardify-4ee15.firebaseapp.com",
  projectId: "cardify-4ee15",
  storageBucket: "cardify-4ee15.firebasestorage.app",
  messagingSenderId: "544742568264",
  appId: "1:544742568264:web:45d25efdee5bd4dbf7c37d",
  measurementId: "G-940GHMF49K",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);

/**
 * Session lives in sessionStorage (per browser tab). New tabs start signed-out unless they log in again.
 * Resolve before sign-in / auth listeners so Firebase applies this persistence consistently.
 */
export const authPersistenceReady = setPersistence(auth, browserSessionPersistence).catch(function (e) {
  console.warn("SynthIQ: could not set per-tab auth persistence", e);
});

isSupported()
  .then(function (ok) {
    if (ok) getAnalytics(app);
  })
  .catch(function () {});

/**
 * Firestore rules use request.auth.uid — wait for Auth + force a fresh ID token before writes.
 * @param {string} uid
 */
export async function refreshIdTokenForFirestore(uid) {
  await authPersistenceReady;
  if (typeof auth.authStateReady === "function") {
    await auth.authStateReady();
  }
  var u = auth.currentUser;
  if (!u || u.uid !== uid) {
    var err = new Error("Sign-in session not ready for Firestore.");
    err.code = "auth/not-ready-for-firestore";
    throw err;
  }
  await u.getIdToken(true);
}

/** @param {Record<string, unknown>} obj */
function stripUndefined(obj) {
  Object.keys(obj).forEach(function (k) {
    if (obj[k] === undefined) delete obj[k];
  });
}

/** Node API origin: prefers meta synthiq-api-base or window.__SYNTHIQ_API_BASE__, else page origin. */
function synthiqServerApiOrigin() {
  try {
    var m = document.querySelector('meta[name="synthiq-api-base"]');
    var mc = m && m.getAttribute("content");
    if (mc != null && String(mc).trim()) return String(mc).trim().replace(/\/$/, "");
  } catch (_) {}
  if (typeof window !== "undefined" && window.__SYNTHIQ_API_BASE__) {
    var custom = String(window.__SYNTHIQ_API_BASE__).replace(/\/$/, "");
    if (custom) return custom;
  }
  if (typeof window !== "undefined" && window.location && window.location.origin) {
    return String(window.location.origin).replace(/\/$/, "");
  }
  return "";
}

/**
 * Trusted Firestore write via SynthIQ Node server (firebase-admin).
 * Bypasses flaky browser/App Check/rules issues. Falls back to client `setDoc` when server returns 503.
 * @param {*} user Firebase Auth user (`cred.user`)
 * @param {Record<string, unknown>} profileFields Plain fields only (email, fullName, username, …).
 */
async function syncUserProfileThroughServer(user, profileFields) {
  if (typeof window === "undefined") {
    return { ok: false, skip: true };
  }
  var apiOrigin = synthiqServerApiOrigin();
  if (!apiOrigin) {
    return { ok: false, skip: true };
  }
  var idToken;
  try {
    idToken = await user.getIdToken(true);
  } catch {
    return { ok: false, skip: true };
  }
  var url = apiOrigin + "/api/sync-user-profile";
  var res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: idToken, profile: profileFields }),
    });
  } catch {
    return { ok: false, skip: true };
  }
  var data = {};
  try {
    data = await res.json();
  } catch (_) {}
  if (res.ok && data.ok) return { ok: true };
  if (res.status === 503 && data.configured === false) return { ok: false, skip: true, hint: data.hint };
  return { ok: false, skip: true };
}

/**
 * If users/{uid} is missing (older session), create a minimal profile from Auth.
 * @param {{ uid: string, email?: string | null, displayName?: string | null }} user
 */
export async function ensureUserProfileDocument(user) {
  if (!user || !user.uid) return;
  await refreshIdTokenForFirestore(user.uid);
  var ref = doc(db, "users", user.uid);
  var snap = await getDoc(ref);
  if (snap.exists()) return;
  var payload = {
    email: user.email || null,
    fullName: user.displayName || null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  stripUndefined(payload);
  await setDoc(ref, payload, { merge: true });
}

/** Lowercased username key for `usernames/{key}` (teams / invites). */
export function normalizeSynthIQUsername(username) {
  return String(username || "")
    .trim()
    .toLowerCase();
}

/**
 * Reserve `usernames/{key}` → { uid }. Best-effort after signup; logs on failure.
 * @param {string} uid
 * @param {string} usernameRaw
 */
async function claimUsernameBestEffort(uid, usernameRaw) {
  var key = normalizeSynthIQUsername(usernameRaw);
  if (!key || !/^[a-z0-9._-]+$/.test(key)) return;
  try {
    await runTransaction(db, async function (tx) {
      var usernameRef = doc(db, "usernames", key);
      var usernameSnap = await tx.get(usernameRef);
      if (usernameSnap.exists()) {
        var existingUid = usernameSnap.data().uid;
        if (existingUid && existingUid !== uid) {
          throw new Error("username-taken");
        }
        return;
      }
      tx.set(usernameRef, { uid: uid });
    });
  } catch (e) {
    console.warn("SynthIQ: could not reserve username index", e);
  }
}

/** Backfill `usernames/` from `users/{uid}.username` (e.g. legacy accounts). */
export async function ensureUsernameIndexFromProfile(uid) {
  if (!uid) return;
  try {
    await refreshIdTokenForFirestore(uid);
    var snap = await getDoc(doc(db, "users", uid));
    if (!snap.exists()) return;
    var un = snap.data().username;
    if (!un) return;
    await claimUsernameBestEffort(uid, String(un));
  } catch (e) {
    console.warn("SynthIQ: ensureUsernameIndexFromProfile", e);
  }
}

/**
 * @param {string} email
 * @param {string} password
 * @param {string} displayName
 * @param {{ username?: string, phone?: string, phoneCountry?: string }} [extra]
 */
export async function registerSynthIQ(email, password, displayName, extra) {
  extra = extra || {};
  await authPersistenceReady;
  var cred = await createUserWithEmailAndPassword(auth, email, password);
  var user = cred.user;
  if (displayName && user) {
    await updateProfile(user, { displayName: displayName });
  }
  await refreshIdTokenForFirestore(user.uid);

  var profileFields = {
    email: email,
    fullName: displayName || null,
    username: extra.username != null ? extra.username : null,
    phone: extra.phone != null && extra.phone !== "" ? extra.phone : null,
    phoneCountry: extra.phoneCountry != null && extra.phoneCountry !== "" ? extra.phoneCountry : null,
  };
  stripUndefined(profileFields);

  var serverSync = await syncUserProfileThroughServer(user, profileFields);
  if (!serverSync.ok) {
    var payload = Object.assign({}, profileFields, {
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    stripUndefined(payload);
    await setDoc(doc(db, "users", user.uid), payload, { merge: true });
  }

  if (profileFields.username != null && String(profileFields.username).trim()) {
    claimUsernameBestEffort(user.uid, String(profileFields.username));
  }

  return cred;
}

/**
 * @param {string} email
 * @param {string} password
 */
export async function signInSynthIQ(email, password) {
  await authPersistenceReady;
  var cred = await signInWithEmailAndPassword(auth, email, password);
  await refreshIdTokenForFirestore(cred.user.uid);
  await setDoc(
    doc(db, "users", cred.user.uid),
    {
      email: cred.user.email || email,
      lastLoginAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
  await ensureUsernameIndexFromProfile(cred.user.uid);
  return cred;
}

/**
 * Sends Firebase password-reset email (user sets a new password via Firebase’s link — never stored in Firestore).
 * @param {string} email
 */
export async function sendSynthIQPasswordResetEmail(email) {
  var trimmed = String(email || "").trim().toLowerCase();
  if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    var bad = new Error("Enter the email you signed up with.");
    bad.code = "auth/invalid-email";
    throw bad;
  }
  var actionCodeSettings =
    typeof window !== "undefined" && window.location && window.location.origin
      ? {
          url: window.location.origin + "/signup/synthiq-signin.html?pwdReset=1",
          handleCodeInApp: false,
        }
      : undefined;
  if (actionCodeSettings) {
    await sendPasswordResetEmail(auth, trimmed, actionCodeSettings);
  } else {
    await sendPasswordResetEmail(auth, trimmed);
  }
}

/** @param {*} user */
function userHasPasswordProvider(user) {
  if (!user || !user.providerData) return false;
  return user.providerData.some(function (p) {
    return p.providerId === "password";
  });
}

/**
 * Change password for the signed-in email/password account (requires current password).
 * @param {string} currentPassword
 * @param {string} newPassword
 */
export async function updateSynthIQPassword(currentPassword, newPassword) {
  var user = auth.currentUser;
  if (!user || !user.email) {
    var noUser = new Error("Not signed in.");
    noUser.code = "auth/no-current-user";
    throw noUser;
  }
  if (!userHasPasswordProvider(user)) {
    var noPw = new Error("This account did not sign up with email and password.");
    noPw.code = "auth/account-not-password";
    throw noPw;
  }
  var cred = EmailAuthProvider.credential(user.email, currentPassword);
  await reauthenticateWithCredential(user, cred);
  await updatePassword(user, newPassword);
}

/**
 * @param {string} code
 */
export function authErrorMessage(code) {
  var map = {
    "auth/email-already-in-use": "That email is already registered. Try signing in instead.",
    "auth/invalid-email": "That email address doesn’t look valid.",
    "auth/weak-password": "Password is too weak. Use at least 6 characters (SynthIQ recommends 8+).",
    "auth/network-request-failed": "Network error. Check your connection and try again.",
    "auth/user-not-found": "No account found with that email.",
    "auth/wrong-password": "Incorrect password.",
    "auth/invalid-credential": "Email or password is incorrect.",
    "auth/invalid-login-credentials": "Email or password is incorrect.",
    "auth/too-many-requests": "Too many attempts. Wait a moment and try again.",
    "auth/operation-not-allowed": "Email/password sign-in isn’t enabled for this project yet (Firebase console).",
    "permission-denied":
      "Firestore blocked this action. In Firebase Console → Firestore → Rules, publish rules that allow signed-in users to write their own `users/{uid}` document.",
    unavailable:
      "Could not reach Firestore. Confirm Firestore Database exists on project cardify-4ee15 and try another network.",
    "failed-precondition": "Firestore refused the request (check console setup).",
    unauthenticated: "You are not signed in for Firestore. Refresh and try again.",
    "auth/no-current-user": "Sign in again, then try changing your password.",
    "auth/account-not-password":
      "This account uses Google or another sign-in method — use “Forgot password?” only if you created an email/password account.",
    "auth/requires-recent-login": "For security, sign out and sign in again, then change your password.",
    "auth/invalid-action-code":
      "This reset link expired or was already used. Tap Forgot password? to get a new email.",
    "auth/not-ready-for-firestore":
      "Your session was not ready yet. Refresh once and try again.",
  };
  return map[code] || "Something went wrong. Please try again.";
}
