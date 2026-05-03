/**
 * Read a browser File into an attachment object for Firestore team posts.
 * Keeps data URLs under a safe length for Firestore (~1 MiB document limit).
 * Images over the raw-read limit are resized/compressed as JPEG when possible.
 */

const MAX_DATA_URL_CHARS = 275000;
const MAX_RAW_READ_BYTES = 175000;

function readFullAsDataUrl(file) {
  return new Promise(function (resolve) {
    const fr = new FileReader();
    fr.onload = function () {
      resolve(String(fr.result || ""));
    };
    fr.onerror = function () {
      resolve("");
    };
    fr.readAsDataURL(file);
  });
}

function loadHtmlImage(file) {
  return new Promise(function (resolve, reject) {
    const u = URL.createObjectURL(file);
    const im = new Image();
    im.onload = function () {
      URL.revokeObjectURL(u);
      resolve(im);
    };
    im.onerror = function () {
      URL.revokeObjectURL(u);
      reject(new Error("image-load"));
    };
    im.src = u;
  });
}

/**
 * @param {File} file
 * @param {number} maxChars
 * @returns {Promise<string>}
 */
async function compressImageToDataUrlUnder(file, maxChars) {
  try {
    let src;
    try {
      src = await createImageBitmap(file);
    } catch (_) {
      src = await loadHtmlImage(file);
    }
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    let w = "naturalWidth" in src ? src.naturalWidth : src.width;
    let h = "naturalHeight" in src ? src.naturalHeight : src.height;
    let maxDim = 1920;

    for (let attempt = 0; attempt < 12; attempt++) {
      let rw = w;
      let rh = h;
      if (w > maxDim || h > maxDim) {
        if (w >= h) {
          rw = maxDim;
          rh = Math.round((h * maxDim) / w);
        } else {
          rh = maxDim;
          rw = Math.round((w * maxDim) / h);
        }
      }
      canvas.width = rw;
      canvas.height = rh;
      ctx.drawImage(src, 0, 0, rw, rh);

      const qualities = [0.88, 0.78, 0.65, 0.52, 0.4, 0.3, 0.22];
      for (let qi = 0; qi < qualities.length; qi++) {
        const url = canvas.toDataURL("image/jpeg", qualities[qi]);
        if (url.length <= maxChars) {
          if (src && typeof src.close === "function") src.close();
          return url;
        }
      }
      maxDim = Math.max(480, Math.floor(maxDim * 0.82));
    }
    const fallback = canvas.toDataURL("image/jpeg", 0.18);
    if (src && typeof src.close === "function") src.close();
    return fallback.length <= maxChars ? fallback : "";
  } catch (e) {
    console.warn("SynthIQ image compress", e);
    return "";
  }
}

/**
 * @param {File} file
 * @returns {Promise<{ name: string, mimeType: string, size: number, dataUrl: string }>}
 */
export async function readAttachmentFromFile(file) {
  const name = file.name || "file";
  const mimeType = file.type || "application/octet-stream";
  const size = file.size || 0;

  if (!size) {
    return { name, mimeType, size: 0, dataUrl: "" };
  }

  if (mimeType.startsWith("image/")) {
    if (size <= MAX_RAW_READ_BYTES) {
      const full = await readFullAsDataUrl(file);
      if (full && full.length <= MAX_DATA_URL_CHARS && /^data:image\//i.test(full)) {
        return { name, mimeType, size, dataUrl: full };
      }
    }
    const compressed = await compressImageToDataUrlUnder(file, MAX_DATA_URL_CHARS);
    if (compressed && compressed.length <= MAX_DATA_URL_CHARS) {
      return { name, mimeType: "image/jpeg", size, dataUrl: compressed };
    }
    return { name, mimeType, size, dataUrl: "" };
  }

  if (size <= MAX_RAW_READ_BYTES) {
    const dataUrl = await readFullAsDataUrl(file);
    if (dataUrl && dataUrl.length <= MAX_DATA_URL_CHARS) {
      return { name, mimeType, size, dataUrl };
    }
  }

  return { name, mimeType, size, dataUrl: "" };
}

export { MAX_DATA_URL_CHARS };
