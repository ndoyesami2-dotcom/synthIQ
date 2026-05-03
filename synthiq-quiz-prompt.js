/**
 * Build a quiz question string from flashcard front/back (client-side, no AI).
 */

function trimStr(s) {
  return String(s || "").trim();
}

/** True if string is mostly a numeric expression (e.g. 1+1, 9 * 9). */
function looksLikeArithmetic(chunk) {
  var t = trimStr(chunk).replace(/\s+/g, "");
  if (t.length < 1 || t.length > 48) return false;
  return /^[\d+\-*/×÷.,()^]+$/.test(t);
}

function normalizeMathForQuestion(chunk) {
  return trimStr(chunk).replace(/\s+/g, "");
}

/**
 * "left is right" / "left = right" / "left equals right"
 * @returns {{ left: string, right: string } | null}
 */
function splitFactStatement(s) {
  var t = trimStr(s);
  if (!t) return null;
  var m = t.match(/^([\s\S]+?)\s+(?:is|=|equals|→|->)\s+([\s\S]+)$/i);
  if (!m) return null;
  return { left: trimStr(m[1]), right: trimStr(m[2]) };
}

/**
 * @param {string} frontRaw
 * @param {string} backRaw
 * @returns {{ prompt: string }}
 */
export function buildQuizPrompt(frontRaw, backRaw) {
  var front = trimStr(frontRaw);
  var back = trimStr(backRaw);

  var fromFront = splitFactStatement(front);
  if (fromFront && fromFront.left) {
    var L = fromFront.left;
    var compact = L.replace(/\s+/g, "");
    if (looksLikeArithmetic(compact)) {
      return { prompt: "How much is " + normalizeMathForQuestion(L) + "?" };
    }
    if (L.length <= 120) {
      return { prompt: "What is " + L + "?" };
    }
  }

  if (front && looksLikeArithmetic(front.replace(/\s+/g, ""))) {
    return { prompt: "How much is " + normalizeMathForQuestion(front) + "?" };
  }

  /* Term on front, longer explanation on back */
  if (front && front.length <= 55 && !/\?\s*$/.test(front) && back.length > front.length + 8) {
    return { prompt: "What is " + front + "?" };
  }

  return { prompt: front || "—" };
}
