/**
 * Inline previews + download links for team post attachments
 * (data URLs, blob: previews before publish, or Firebase Storage HTTPS URLs).
 */

export function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

/** Direct Firebase Storage download URLs — keep file Download / Open UI. */
function isFirebaseStorageDownloadUrl(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    if (h === "firebasestorage.googleapis.com") return true;
    if (h === "storage.googleapis.com" && /\/v0\/b\//.test(u.pathname)) return true;
    return false;
  } catch (_) {
    return false;
  }
}

/** Pasted workspace links (Drive, Dropbox, etc.) — preview + Enter, hide raw URL. */
function isExternalWorkspaceLink(url) {
  return /^https?:\/\//i.test(url) && !isFirebaseStorageDownloadUrl(url);
}

function linkHostnameOnly(url) {
  try {
    return String(new URL(url).hostname || "").replace(/^www\./i, "") || "Link";
  } catch (_) {
    return "Link";
  }
}

/**
 * @param {HTMLElement} block - .att-preview-block (title already appended)
 * @param {string} url
 * @param {string} name
 */
function appendExternalWorkspaceLinkCard(block, url, name) {
  const hostEl = document.createElement("div");
  hostEl.className = "att-link-host";
  hostEl.textContent = linkHostnameOnly(url);
  block.appendChild(hostEl);

  const wrap = document.createElement("div");
  wrap.className = "att-link-preview-wrap";

  const iframe = document.createElement("iframe");
  iframe.className = "att-link-preview-frame";
  iframe.title = name ? "Preview: " + name : "Link preview";
  iframe.loading = "lazy";
  iframe.referrerPolicy = "no-referrer-when-downgrade";
  iframe.setAttribute(
    "sandbox",
    "allow-scripts allow-same-origin allow-popups allow-forms allow-popups-to-escape-sandbox",
  );
  iframe.src = url;
  wrap.appendChild(iframe);
  block.appendChild(wrap);

  const hint = document.createElement("p");
  hint.className = "att-link-preview-hint hint";
  hint.textContent =
    "Preview may be empty if this site blocks embedding — use Enter to open it fully in a new tab.";
  block.appendChild(hint);

  const row = document.createElement("div");
  row.className = "att-link-actions";

  const enterBtn = document.createElement("button");
  enterBtn.type = "button";
  enterBtn.className = "att-enter-link-btn";
  enterBtn.textContent = "Enter";
  enterBtn.setAttribute("aria-label", "Open linked page in a new tab");
  enterBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    window.open(url, "_blank", "noopener,noreferrer");
  });
  row.appendChild(enterBtn);
  block.appendChild(row);
}

function isLocalhostSynthIQHost() {
  try {
    const h = String(window.location.hostname || "");
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  } catch (_) {
    return false;
  }
}

function fallbackBrowserDownload(href, filename) {
  const a = document.createElement("a");
  a.href = href;
  if (filename) a.download = filename;
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Windows + localhost + node server: write attachment into user's Downloads folder. */
async function trySaveFileToWindowsDownloads(filename, href) {
  if (!isLocalhostSynthIQHost()) return false;
  let payload = null;
  if (/^https?:\/\//i.test(href)) {
    payload = { filename: filename, url: href };
  } else if (/^data:/i.test(href)) {
    payload = { filename: filename, dataUrl: href };
  } else if (/^blob:/i.test(href)) {
    try {
      const blob = await fetch(href).then(function (r) {
        return r.blob();
      });
      if (blob.size > 26 * 1024 * 1024) return false;
      const dataUrl = await new Promise(function (resolve, reject) {
        const fr = new FileReader();
        fr.onloadend = function () {
          resolve(fr.result);
        };
        fr.onerror = reject;
        fr.readAsDataURL(blob);
      });
      payload = { filename: filename, dataUrl: dataUrl };
    } catch (_) {
      return false;
    }
  }
  if (!payload) return false;

  let origin = "";
  try {
    origin = window.location.origin || "";
  } catch (_) {}
  if (!origin || origin === "null") return false;

  try {
    const r = await fetch(origin + "/api/save-to-downloads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(function () {
      return {};
    });
    if (!r.ok || !j.ok) return false;
    return true;
  } catch (_) {
    return false;
  }
}

export async function downloadAttachmentSmart(filename, href) {
  const ok = await trySaveFileToWindowsDownloads(filename, href);
  if (!ok) fallbackBrowserDownload(href, filename);
}

/** @param {HTMLElement} block */
function appendDownloadRow(block, href, name, opts) {
  opts = opts || {};
  const preferNewTab = !!opts.preferNewTab;
  const dlRow = document.createElement("div");
  dlRow.className = "att-download-row";

  const dl = document.createElement("a");
  dl.href = href;
  dl.download = name;
  dl.className = "att-download-primary";
  dl.textContent = "Download";
  dl.setAttribute("aria-label", "Download " + name);
  if (preferNewTab) {
    dl.target = "_blank";
    dl.rel = "noopener noreferrer";
  }
  if (isLocalhostSynthIQHost()) {
    dl.title = "Saves into your Downloads folder when SynthIQ runs via node server on localhost.";
    dl.addEventListener("click", async function (e) {
      e.preventDefault();
      e.stopPropagation();
      await downloadAttachmentSmart(name, href);
    });
  }
  dlRow.appendChild(dl);

  const openTab = document.createElement("a");
  openTab.href = href;
  openTab.target = "_blank";
  openTab.rel = "noopener noreferrer";
  openTab.className = "att-download-open";
  openTab.textContent = "Open in new tab";
  openTab.setAttribute("aria-label", "Open " + name + " in a new tab");
  dlRow.appendChild(openTab);

  block.appendChild(dlRow);
}

/**
 * @param {HTMLElement} block
 * @param {string} url - data: or blob: or https:
 * @param {string} mime
 * @param {string} name
 */
function appendInlineMediaPreview(block, url, mime, name) {
  const isData = /^data:/i.test(url);
  const isHttps = /^https?:\/\//i.test(url);

  const looksImage =
    mime.startsWith("image/") || (isData && /^data:image\//i.test(url)) || /\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(name);

  if (looksImage) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = name;
    img.className = "att-preview-img";
    img.loading = "lazy";
    if (isHttps) img.referrerPolicy = "no-referrer";
    block.appendChild(img);
    return true;
  }

  const looksPdf =
    mime === "application/pdf" ||
    mime === "application/x-pdf" ||
    (isData && /^data:application\/(pdf|x-pdf)/i.test(url)) ||
    /\.pdf$/i.test(name);

  if (looksPdf) {
    const iframe = document.createElement("iframe");
    iframe.className = "att-preview-frame";
    iframe.title = name;
    iframe.src = url;
    block.appendChild(iframe);
    return true;
  }

  if (mime.startsWith("video/") || (isData && /^data:video\//i.test(url))) {
    const v = document.createElement("video");
    v.className = "att-preview-video";
    v.controls = true;
    v.src = url;
    block.appendChild(v);
    return true;
  }

  if (mime.startsWith("audio/") || (isData && /^data:audio\//i.test(url))) {
    const aud = document.createElement("audio");
    aud.controls = true;
    aud.src = url;
    aud.style.width = "100%";
    block.appendChild(aud);
    return true;
  }

  if (isData && /^data:text\//i.test(url)) {
    try {
      const comma = url.indexOf(",");
      const meta = url.slice(5, comma);
      const payload = url.slice(comma + 1);
      let text = "";
      if (/;base64/i.test(meta)) {
        text = decodeURIComponent(
          Array.prototype.map
            .call(atob(payload), function (c) {
              return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
            })
            .join(""),
        );
      } else {
        text = decodeURIComponent(payload.replace(/\+/g, " "));
      }
      const pre = document.createElement("pre");
      pre.className = "att-preview-text";
      const max = 12000;
      pre.textContent = text.length > max ? text.slice(0, max) + "\n…" : text;
      block.appendChild(pre);
      return true;
    } catch (_) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "Preview not available for this text file.";
      block.appendChild(p);
      return true;
    }
  }

  const p = document.createElement("p");
  p.className = "hint";
  p.textContent = "No visual preview for this type — download to open.";
  block.appendChild(p);
  return true;
}

/**
 * @param {HTMLElement} wrap - parent to append to
 * @param {{ name?: string, mimeType?: string, size?: number, dataUrl?: string, storageUrl?: string }} att
 * @param {{ showDownload?: boolean }} opts
 */
export function appendAttachmentPreviewBlock(wrap, att, opts) {
  opts = opts || {};
  const showDownload = opts.showDownload !== false;
  const name = att.name || "file";
  const mime = String(att.mimeType || "").toLowerCase();
  const dataUrl = String(att.dataUrl || att.dataURL || "").trim();
  const storageUrl = String(att.storageUrl || "").trim();

  const block = document.createElement("div");
  block.className = "att-preview-block";

  const titleEl = document.createElement("div");
  titleEl.className = "att-preview-name";
  titleEl.textContent = name;
  block.appendChild(titleEl);

  const hasInline =
    dataUrl && (/^data:/i.test(dataUrl) || /^blob:/i.test(dataUrl));
  const hasStorage = storageUrl && /^https?:\/\//i.test(storageUrl);

  if (hasInline) {
    appendInlineMediaPreview(block, dataUrl, mime, name);
    if (showDownload) appendDownloadRow(block, dataUrl, name, { preferNewTab: /^blob:/i.test(dataUrl) });
  } else if (hasStorage) {
    if (isExternalWorkspaceLink(storageUrl)) {
      appendExternalWorkspaceLinkCard(block, storageUrl, name);
    } else {
      appendInlineMediaPreview(block, storageUrl, mime, name);
      if (showDownload) appendDownloadRow(block, storageUrl, name, { preferNewTab: true });
    }
  } else {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = name + " — No preview or download link for this attachment.";
    block.appendChild(p);
  }

  wrap.appendChild(block);
}
