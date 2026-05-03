/**
 * Shared Account modal: profile info + photo (Firestore users/{uid}.profilePhotoDataUrl + Auth photoURL).
 */
import {
  auth,
  db,
  refreshIdTokenForFirestore,
  ensureUserProfileDocument,
} from "../signup/signup-firebase.js";
import { updateProfile } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

let cachedProfilePhotoDataUrl = "";

/** Map Firestore `users/{uid}.plan` to sidebar label (missing → free). */
export function planDisplayFromFirestore(planField) {
  const p = String(planField || "")
    .trim()
    .toLowerCase();
  if (p === "pro") return "Pro";
  return "Free plan";
}

function initialsFromUser(user) {
  const n = user?.displayName?.trim();
  if (n) {
    const parts = n.split(/\s+/).filter(Boolean);
    const a = parts[0]?.[0] || "";
    const b = parts[1]?.[0] || "";
    return (a + b).toUpperCase().slice(0, 2) || "?";
  }
  const em = user?.email?.trim();
  if (em) return em.slice(0, 2).toUpperCase();
  return "?";
}

/**
 * Load saved photo from Firestore into cache (call after sign-in).
 * @param {string} uid
 */
export async function syncAccountPhotoCache(uid) {
  if (!uid) return;
  await refreshIdTokenForFirestore(uid);
  const user = auth.currentUser;
  if (user) await ensureUserProfileDocument(user);
  try {
    const ud = await getDoc(doc(db, "users", uid));
    cachedProfilePhotoDataUrl =
      ud.exists() && typeof ud.data().profilePhotoDataUrl === "string"
        ? String(ud.data().profilePhotoDataUrl)
        : "";
  } catch (_) {
    cachedProfilePhotoDataUrl = "";
  }
}

/**
 * @param {import("firebase/auth").User | null} user
 * @param {{ wrapId: string, imgId: string, fallbackId: string } | null} sidebar
 */
export function refreshAccountAvatarSlots(user, sidebar) {
  if (!user) return;
  const authUrl = user.photoURL && String(user.photoURL).trim();
  const url = authUrl || cachedProfilePhotoDataUrl || "";
  if (sidebar && sidebar.wrapId) {
    const wrap = document.getElementById(sidebar.wrapId);
    const img = document.getElementById(sidebar.imgId);
    const fb = document.getElementById(sidebar.fallbackId);
    if (wrap && img && fb) {
      if (url) {
        img.src = url;
        wrap.classList.add("has-photo");
      } else {
        img.removeAttribute("src");
        wrap.classList.remove("has-photo");
        fb.textContent = initialsFromUser(user);
      }
    }
  }
}

function refreshModalPreview(user) {
  if (!user) return;
  const authUrl = user.photoURL && String(user.photoURL).trim();
  const url = authUrl || cachedProfilePhotoDataUrl || "";
  const wrap = document.getElementById("accountAvatarPreview");
  const img = document.getElementById("accountAvatarImg");
  const fb = document.getElementById("accountAvatarFallback");
  if (!wrap || !img || !fb) return;
  if (url) {
    img.src = url;
    wrap.classList.add("has-photo");
  } else {
    img.removeAttribute("src");
    wrap.classList.remove("has-photo");
    fb.textContent = initialsFromUser(user);
  }
}

function openAccountModal() {
  const user = auth.currentUser;
  if (!user) return;
  const m = document.getElementById("accountModal");
  if (!m) return;
  const dn = document.getElementById("accDisplayName");
  const em = document.getElementById("accEmail");
  const uidEl = document.getElementById("accUid");
  const msg = document.getElementById("accountPhotoMsg");
  if (dn) dn.textContent = user.displayName || "—";
  if (em) em.textContent = user.email || "—";
  if (uidEl) uidEl.textContent = user.uid;
  if (msg) msg.textContent = "";
  refreshModalPreview(user);
  m.classList.add("is-open");
  m.setAttribute("aria-hidden", "false");
}

export function closeSynthIQAccountModal() {
  const m = document.getElementById("accountModal");
  if (!m) return;
  m.classList.remove("is-open");
  m.setAttribute("aria-hidden", "true");
  const inp = document.getElementById("hiddenProfilePhoto");
  if (inp) inp.value = "";
}

function fileToProfileDataUrl(file, done) {
  const blobUrl = URL.createObjectURL(file);
  const img = new Image();
  img.onload = function () {
    URL.revokeObjectURL(blobUrl);
    let dim = 384;
    let q = 0.82;
    function attempt() {
      const scale = Math.min(dim / img.width, dim / img.height, 1);
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      const dataUrl = c.toDataURL("image/jpeg", q);
      if (dataUrl.length > 520000 && dim > 160) {
        dim = Math.floor(dim * 0.72);
        attempt();
        return;
      }
      if (dataUrl.length > 520000 && q > 0.55) {
        q -= 0.08;
        attempt();
        return;
      }
      done(dataUrl.length > 950000 ? null : dataUrl);
    }
    attempt();
  };
  img.onerror = function () {
    URL.revokeObjectURL(blobUrl);
    done(null);
  };
  img.src = blobUrl;
}

/**
 * @param {{ getMyUid: () => string; openSelectors: string[]; sidebarAvatar: { wrapId: string, imgId: string, fallbackId: string } | null }} opts
 */
export function bindSynthIQAccountUi(opts) {
  const getMyUid = opts.getMyUid;
  const sidebar = opts.sidebarAvatar || null;
  const selectors = opts.openSelectors || [];

  selectors.forEach(function (sel) {
    document.querySelectorAll(sel).forEach(function (el) {
      el.addEventListener("click", function (e) {
        if (el.tagName === "A") e.preventDefault();
        openAccountModal();
      });
    });
  });

  const accountModalEl = document.getElementById("accountModal");
  const closeBtn = document.getElementById("accountModalClose");
  if (closeBtn) closeBtn.addEventListener("click", closeSynthIQAccountModal);
  if (accountModalEl) {
    accountModalEl.addEventListener("click", function (e) {
      if (e.target === accountModalEl) closeSynthIQAccountModal();
    });
  }

  const pickBtn = document.getElementById("btnPickProfilePhoto");
  const hiddenInp = document.getElementById("hiddenProfilePhoto");
  if (pickBtn && hiddenInp) {
    pickBtn.addEventListener("click", function () {
      hiddenInp.click();
    });
    hiddenInp.addEventListener("change", function () {
      const f = this.files && this.files[0];
      const msgEl = document.getElementById("accountPhotoMsg");
      if (msgEl) msgEl.textContent = "";
      if (!f || !f.type.startsWith("image/")) {
        this.value = "";
        return;
      }
      const uid = getMyUid();
      if (!uid) {
        this.value = "";
        return;
      }
      if (msgEl) msgEl.textContent = "Processing…";
      const inputEl = this;
      fileToProfileDataUrl(f, async function (dataUrl) {
        if (!dataUrl) {
          if (msgEl) msgEl.textContent = "Could not read that image. Try another JPEG or PNG.";
          inputEl.value = "";
          return;
        }
        try {
          await refreshIdTokenForFirestore(uid);
          await setDoc(
            doc(db, "users", uid),
            { profilePhotoDataUrl: dataUrl, updatedAt: serverTimestamp() },
            { merge: true }
          );
          cachedProfilePhotoDataUrl = dataUrl;
          try {
            await updateProfile(auth.currentUser, { photoURL: dataUrl });
          } catch (pe) {
            console.warn("SynthIQ: updateProfile photoURL", pe);
          }
          refreshAccountAvatarSlots(auth.currentUser, sidebar);
          refreshModalPreview(auth.currentUser);
          if (msgEl) msgEl.textContent = "Photo saved.";
        } catch (err) {
          console.warn(err);
          if (msgEl) msgEl.textContent = err.message || "Could not save photo.";
        }
        inputEl.value = "";
      });
    });
  }
}
