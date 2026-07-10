import { safeCompareSecret } from "./tokens.js";

export function resolveCaptchaDevBypassKey(
  captchaDevBypassKey: string | undefined,
  mcpApiKey: string | undefined,
): string | undefined {
  return captchaDevBypassKey?.trim() || mcpApiKey?.trim() || undefined;
}

export function isCaptchaDevBypassAuthorized(
  provided: string | undefined,
  captchaDevBypassKey: string | undefined,
  mcpApiKey: string | undefined,
): boolean {
  const expected = resolveCaptchaDevBypassKey(captchaDevBypassKey, mcpApiKey);
  if (!expected || !provided?.trim()) {
    return false;
  }
  return safeCompareSecret(provided.trim(), expected);
}
