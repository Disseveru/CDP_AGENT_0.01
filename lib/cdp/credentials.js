const crypto = require("crypto");

/**
 * Resolves CDP credentials from supported environment variables.
 *
 * @returns {{ apiKeyId: string, apiKeySecretLegacy: string, apiKeySecretV2: string, walletSecret: string }}
 */
function resolveCdpCredentials() {
  const apiKeyId = process.env.CDP_API_KEY || process.env.CDP_API_KEY_ID;
  const apiKeySecretRaw = process.env.CDP_PRIVATE_KEY || process.env.CDP_API_KEY_SECRET;
  const walletSecret = process.env.CDP_WALLET_SECRET;

  if (!apiKeyId || !apiKeySecretRaw || !walletSecret) {
    throw new Error(
      "Missing CDP credentials. Set CDP_API_KEY (or CDP_API_KEY_ID), CDP_PRIVATE_KEY (or CDP_API_KEY_SECRET), and CDP_WALLET_SECRET.",
    );
  }

  let pem = apiKeySecretRaw.replace(/\\n/g, "\n").trim();

  if (!pem.includes("\n")) {
    const match = pem.match(/-----BEGIN ([^-]+)-----(.*?)-----END \1-----/);
    if (match) {
      const [, type, body] = match;
      const cleanBody = body.replace(/\s+/g, "");
      const lines = cleanBody.match(/.{1,64}/g) || [];
      pem = `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----`;
    }
  }

  const apiKeySecretLegacy = pem;
  const apiKeySecretV2 = pem.includes("BEGIN EC PRIVATE KEY")
    ? crypto.createPrivateKey({ key: pem, format: "pem", type: "sec1" }).export({
        format: "pem",
        type: "pkcs8",
      })
    : pem;

  return { apiKeyId, apiKeySecretLegacy, apiKeySecretV2, walletSecret };
}

module.exports = {
  resolveCdpCredentials,
};
