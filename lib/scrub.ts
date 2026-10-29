// Guardrail 3: remove PII and secrets before anything is stored or sent to an LLM.
// Runs on ingestion (before the DB) and again before any Claude API call. Pure, so it's unit-tested.
// Order matters: whole blocks and URLs first, so their parts aren't half-matched by later rules.

const MAX_TEXT = 4000;

/** Fails closed on oversized input: truncates rather than scanning unbounded text. */
function clamp(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + " …[truncated]" : text;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// Header/field names whose values are always secret.
const SECRET_NAME =
  "(?:password|passwd|pwd|pass|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|x-api-key|access[_-]?key|private[_-]?key|secret[_-]?key|session(?:[_-]?id)?|x-debug-token|x-chaos-token|dsn|auth[_-]?token|credentials?)";

const RULES: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  // PEM blocks (certificates and private keys), whole.
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, "[PEM]"],
  // Database / broker URLs, which carry credentials.
  [/\b(?:mysql|mariadb|postgres(?:ql)?|redis|rediss|mongodb(?:\+srv)?|amqps?|mssql|sqlserver):\/\/[^\s'"<>`]+/gi, "[DB_URL]"],
  // Any other URL with user:password@.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@'"]+:[^\s/@'"]+@/gi, "$1[CREDENTIALS]@"],
  // Cookie and Set-Cookie headers: the whole value.
  [/\b(set-cookie|cookie)(["']?\s*[:=]\s*)[^\n]*/gi, "$1$2[REDACTED]"],
  // Authorization headers: the scheme and the credential.
  [/\b(proxy-authorization|authorization)(["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token|digest)\s+)?[^\s"',;]+/gi, "$1$2[REDACTED]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer [REDACTED]"],
  // Well-known key formats.
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, "[TOKEN]"],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "[TOKEN]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, "[TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[TOKEN]"],
  [/\bsntr[ysu]_[A-Za-z0-9+/=_-]{20,}/g, "[TOKEN]"],
  [/\brnd_[A-Za-z0-9]{16,}/g, "[TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[TOKEN]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[TOKEN]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[TOKEN]"],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[TOKEN]"],
  // URL query parameters that carry secrets (reset links, OAuth codes, signatures).
  [/([?&](?:token|code|key|password|secret|signature|sig|state|access_token|refresh_token|id_token|auth|apikey|api_key)=)[^&\s#'"<>]+/gi, "$1[REDACTED]"],
  // name=value / "name": "value" pairs for secret names.
  [new RegExp(`(\\b${SECRET_NAME}\\b)(["']?\\s*[:=]\\s*["']?)([^\\s"'&,;}\\]]+)`, "gi"), "$1$2[REDACTED]"],
  // Email addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[EMAIL]"],
  // Card-like numbers (13–19 digits, optional space/dash groups) that pass the Luhn check.
  [
    /\b\d(?:[ -]?\d){12,18}\b/g,
    (m) => {
      const digits = m.replace(/[ -]/g, "");
      const grouped = /[ -]/.test(m);
      // Unseparated 13-digit runs are usually epoch-millisecond timestamps, not cards.
      if (!grouped && digits.length < 14) return m;
      return luhnValid(digits) ? "[CARD]" : m;
    },
  ],
  // IPv4 addresses (client IPs are personal data).
  [/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, "[IP]"],
  // Long high-entropy strings (mixed case + digits, 32+ chars): likely keys. Pure hex (hashes, SHAs) is kept.
  [
    /\b[A-Za-z0-9_-]{32,}\b/g,
    (m) => (/[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m) ? "[TOKEN]" : m),
  ],
];

/** Scrub one string. Safe to run more than once (idempotent on its own output). */
export function scrubText(input: string | null | undefined, max: number = MAX_TEXT): string {
  if (!input) return "";
  let text = clamp(String(input), max * 2);
  for (const [pattern, replacement] of RULES) {
    text = typeof replacement === "string" ? text.replace(pattern, replacement) : text.replace(pattern, replacement as (m: string) => string);
  }
  return clamp(text, max);
}

const SECRET_KEY_RE = new RegExp(`^${SECRET_NAME}$|^(?:cookie|set-cookie|authorization|proxy-authorization|headers?)$`, "i");

/** Scrub every string in a JSON-like value; keys that name secrets are replaced wholesale. */
export function scrubDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[DEPTH]";
  if (typeof value === "string") return scrubText(value, 1000);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrubDeep(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      out[key] = SECRET_KEY_RE.test(key) ? "[REDACTED]" : scrubDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}
