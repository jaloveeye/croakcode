import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Compute an HMAC-SHA256 signature over the exact admin policy body string.
 *
 * @param {string} body
 * @param {Buffer|string} key
 * @returns {string} hex signature
 */
export function signAdminPolicy(body, key) {
  return createHmac("sha256", key).update(body).digest("hex");
}

/**
 * Verify an admin policy body against a signature, fail-closed.
 * Returns false on malformed JSON, length mismatch, or mismatched HMAC.
 *
 * @param {string} body
 * @param {string} signature
 * @param {{key: Buffer|string}} opts
 * @returns {boolean}
 */
export function verifyAdminPolicy(body, signature, opts) {
  const { key } = opts ?? {};

  // Malformed body fails before any signature work.
  try {
    JSON.parse(body);
  } catch {
    return false;
  }

  if (typeof signature !== "string") return false;

  const expected = signAdminPolicy(body, key);
  const expectedBuf = Buffer.from(expected, "hex");
  const givenBuf = Buffer.from(signature, "hex");

  // Length mismatch would make timingSafeEqual throw; reject early.
  if (expectedBuf.length !== givenBuf.length) return false;

  return timingSafeEqual(expectedBuf, givenBuf);
}
