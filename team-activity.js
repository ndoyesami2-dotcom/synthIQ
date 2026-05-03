/**
 * Append a team activity row (teams/{teamId}/activity).
 * Caller must ensure Firestore rules allow create for this payload.
 */
import { collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

/**
 * @param {import("firebase/firestore").Firestore} db
 * @param {string} teamId
 * @param {string} actorUid
 * @param {string} actorLabel
 * @param {'post'|'presentation'|'project'|'invite_sent'|'member_joined'|'member_kicked'} type
 * @param {string} summary
 */
export async function logTeamActivity(db, teamId, actorUid, actorLabel, type, summary) {
  const s = String(summary || "").trim().slice(0, 500);
  if (!teamId || !actorUid || !type || !s) return;
  await addDoc(collection(db, "teams", teamId, "activity"), {
    type,
    actorUid,
    actorLabel: String(actorLabel || "Member").slice(0, 120),
    summary: s,
    createdAt: serverTimestamp(),
  });
}
