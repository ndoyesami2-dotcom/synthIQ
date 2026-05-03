import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";

/** @param {string} name */
export function sanitizeStorageSegment(name) {
  return String(name || "file")
    .replace(/[/\\]+/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

/**
 * @param {import("firebase/storage").FirebaseStorage} storage
 * @param {string} teamId
 * @param {string} postId
 * @param {number} index
 * @param {File} file
 * @param {{ name?: string, mimeType?: string, size?: number }} meta
 */
export async function uploadTeamPostAttachment(storage, teamId, postId, index, file, meta) {
  const safe = sanitizeStorageSegment(meta.name || file.name || "file");
  const path = "teams/" + teamId + "/postAttachments/" + postId + "/" + index + "_" + safe;
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, file, {
    contentType: meta.mimeType || file.type || "application/octet-stream",
  });
  const storageUrl = await getDownloadURL(storageRef);
  return {
    name: meta.name || file.name || "file",
    mimeType: meta.mimeType || file.type || "application/octet-stream",
    size: typeof meta.size === "number" ? meta.size : file.size || 0,
    dataUrl: "",
    storageUrl: storageUrl,
  };
}
