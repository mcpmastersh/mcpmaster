// Credential redaction — a deliberately narrow, *targeted* scrub, not a
// generic secret-pattern detector.
//
// The threat it closes: we inject a credential into an outbound call to a
// user-supplied integration, and that endpoint is free to reflect whatever it
// received straight back into its response — or into a tool's name or
// description during introspection, which then gets cached and served
// verbatim to every future list_tools caller (a far wider blast radius than
// one tool call's response).
// We know the EXACT secret strings we just injected, which is what makes an
// exact-match scrub possible and reliable, unlike guessing at shapes.
//
// WHY IT LIVES IN ITS OWN MODULE: this is a pure string function with no
// storage or crypto dependencies, so a test can execute it directly. The
// security-relevant edge cases here (encoded forms, split payloads,
// empty/short secrets) are exactly the kind that need to be executed, not
// read.
//
// WHAT THIS IS NOT: it is not a claim that a credential cannot leak by some
// other transform (gzip, a bespoke cipher, a re-encoded character set we don't
// enumerate). It raises the cost of the obvious reflection attacks and
// composes with — never replaces — the rule that a downstream error's raw
// detail is never surfaced in the first place. No source-visible peer performs
// any transform beyond the ones enumerated below, which is why this is graded
// hardening rather than a finding.

/** Characters that would change meaning inside a RegExp. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** base64url with padding stripped — the form a JWT segment or cookie uses. */
function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/**
 * Every form of `secret` we scrub. The literal form is what an echoing
 * endpoint returns verbatim; the encoded forms are what it returns if it
 * base64s, hexes, or URL-encodes its input before echoing (the encodings a
 * peer plausibly applies without meaning to leak anything).
 */
function encodedForms(secret: string): string[] {
  const forms = new Set<string>([secret]);

  const base64 = Buffer.from(secret, "utf8").toString("base64");
  forms.add(base64);
  forms.add(toBase64Url(secret));

  // The unpadded base64 form differs from padded only when padding exists;
  // adding it unconditionally is harmless but noisy, so only when it differs.
  const unpadded = base64.replace(/=+$/, "");
  if (unpadded) forms.add(unpadded);

  forms.add(Buffer.from(secret, "utf8").toString("hex"));

  const urlEncoded = encodeURIComponent(secret);
  if (urlEncoded !== secret) forms.add(urlEncoded);

  // Drop empty/one-character forms — they would match almost anything and
  // destroy the payload instead of protecting it.
  return [...forms].filter((form) => form.length > 1);
}

/**
 * A secret whose characters were split across separate response parts
 * (an MCP server returning `content: [{text: "sk-abc"}, {text: "def…"}]`)
 * arrives joined with a separator, so the literal string no longer appears
 * even though every character does, in order. This matches the secret's
 * characters with arbitrary whitespace between them.
 *
 * Only applied to secrets long enough that an accidental character run is
 * implausible — a 4-character secret's characters appearing in order across
 * a document is a real possibility, and redacting that would corrupt
 * legitimate content for no security gain.
 */
const MIN_LENGTH_FOR_SPLIT_MATCH = 12;

function splitTolerantPattern(secret: string): RegExp | null {
  if (secret.length < MIN_LENGTH_FOR_SPLIT_MATCH) return null;
  const chars = [...secret].map(escapeRegex);
  return new RegExp(chars.join("\\s*"), "g");
}

/**
 * Replaces every occurrence of each secret — and of the encoded or
 * part-split variants of it — with a fixed marker.
 *
 * Over-redaction is the accepted failure direction: replacing a string that
 * merely looks like a credential costs a caller some legibility, while
 * failing to replace a real one leaks the credential to whoever is reading
 * the response.
 */
export function redactSecrets(text: string, secrets: string[]): string {
  if (!text || secrets.length === 0) return text;

  let redacted = text;

  for (const secret of secrets) {
    if (!secret) continue;

    for (const form of encodedForms(secret)) {
      redacted = redacted.split(form).join("[REDACTED]");
    }

    const splitPattern = splitTolerantPattern(secret);
    if (splitPattern) {
      // The pattern carries /g, and replace() resets lastIndex for a global
      // regex, so reusing this instance across calls is safe.
      redacted = redacted.replace(splitPattern, "[REDACTED]");
    }
  }

  return redacted;
}
