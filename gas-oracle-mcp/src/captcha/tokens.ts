import crypto from "node:crypto";

/** Generate a URL-safe secret for CAPTCHA poll/solve authorization. */
export function generateCaptchaSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function safeCompareSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}
