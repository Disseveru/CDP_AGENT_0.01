const assert = require("node:assert/strict");
const test = require("node:test");

const { resolveCdpCredentials } = require("./index.js");

function withEnv(overrides, run) {
  const previous = new Map();

  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("resolveCdpCredentials accepts standard CDP SDK alias names", () => {
  withEnv(
    {
      CDP_API_KEY: undefined,
      CDP_PRIVATE_KEY: undefined,
      CDP_API_KEY_ID: "alias-key-id",
      CDP_API_KEY_SECRET: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
      CDP_WALLET_SECRET: "wallet-secret",
    },
    () => {
      const credentials = resolveCdpCredentials();
      assert.equal(credentials.apiKeyId, "alias-key-id");
      assert.equal(credentials.apiKeySecretLegacy, "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
      assert.equal(credentials.apiKeySecretV2, "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
      assert.equal(credentials.walletSecret, "wallet-secret");
    },
  );
});

test("resolveCdpCredentials keeps canonical variable support", () => {
  withEnv(
    {
      CDP_API_KEY: "primary-key-id",
      CDP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nxyz\\n-----END PRIVATE KEY-----",
      CDP_API_KEY_ID: undefined,
      CDP_API_KEY_SECRET: undefined,
      CDP_WALLET_SECRET: "wallet-secret",
    },
    () => {
      const credentials = resolveCdpCredentials();
      assert.equal(credentials.apiKeyId, "primary-key-id");
      assert.equal(credentials.apiKeySecretLegacy, "-----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----");
      assert.equal(credentials.apiKeySecretV2, "-----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----");
      assert.equal(credentials.walletSecret, "wallet-secret");
    },
  );
});
