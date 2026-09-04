/** Shared USD/USDC amount parsing for paid commerce tools. */
const USDC_PRICE_RE = /^\$?(0|[1-9]\d*)(\.\d{1,6})?$/;

export function parseUsdAmount(raw: unknown, label: string): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (USDC_PRICE_RE.test(trimmed.replace(/^\$/, ""))) {
      return Number(trimmed.replace(/^\$/, ""));
    }
    const n = Number(trimmed.replace(/^\$/, ""));
    if (Number.isFinite(n) && n >= 0) return n;
  }
  throw new Error(`${label} must be a non-negative USD amount (e.g. 1.25 or $0.005)`);
}
