import { JOIN_CODE_PREFIX } from "./protocol.js";

const encoder = new TextEncoder();

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time comparison. Both admin tokens and property tokens are compared
// as hex digests of equal length, so a length mismatch is itself a mismatch.
export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64UrlEncodeBytes(buf);
}

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlEncode(text) {
  return base64UrlEncodeBytes(encoder.encode(text));
}

export function encodeJoinCode(payload) {
  return JOIN_CODE_PREFIX + base64UrlEncode(JSON.stringify(payload));
}

// Property and hood ids end up in entity ids and topic paths, so keep them
// boring: lowercase, alphanumeric, hyphen and underscore only.
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export function isValidId(value) {
  return typeof value === "string" && ID_RE.test(value);
}

export function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function bearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function clampText(value, max) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, max);
}

/**
 * Accept a picture URL only if it is a plain https:// URL.
 *
 * This value ends up in a CSS url() and as entity_picture on every other
 * property's dashboard, so it is attacker-controlled data heading for other
 * people's browsers. Rejecting anything with quoting or escaping characters
 * closes the CSS string as well, belt and braces.
 */
export function safePictureUrl(value) {
  const text = clampText(value, 256);
  if (!text) return null;
  if (/["'()\\<>\s]/.test(text)) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) return null;
  return parsed.toString();
}

const _byteCounter = new TextEncoder();

/** String.length counts UTF-16 code units; a byte budget needs bytes. */
export function byteLength(value) {
  return _byteCounter.encode(value).length;
}
