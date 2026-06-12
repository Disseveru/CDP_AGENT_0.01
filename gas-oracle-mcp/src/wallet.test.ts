import assert from "node:assert/strict";
import test from "node:test";

import { resolveCdpCredentials } from "./wallet.js";

function withEnv(overrides: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map<string, string | undefined>();
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

test("resolveCdpCredentials accepts standard CDP SDK alias names", { concurrency: false }, () => {
  withEnv(
    {
      CDP_API_KEY: undefined,
      CDP_PRIVATE_KEY: undefined,
      CDP_API_KEY_ID: "alias-key-id",
      CDP_API_KEY_SECRET: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
      CDP_WALLET_SECRET: "wallet-secret",
    },
    () => {
      assert.deepEqual(resolveCdpCredentials(), {
        apiKeyId: "alias-key-id",
        apiKeySecret: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
        walletSecret: "wallet-secret",
      });
    },
  );
});

test("resolveCdpCredentials keeps canonical variable support", { concurrency: false }, () => {
  withEnv(
    {
      CDP_API_KEY: "primary-key-id",
      CDP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nxyz\\n-----END PRIVATE KEY-----",
      CDP_API_KEY_ID: undefined,
      CDP_API_KEY_SECRET: undefined,
      CDP_WALLET_SECRET: "wallet-secret",
    },
    () => {
      assert.deepEqual(resolveCdpCredentials(), {
        apiKeyId: "primary-key-id",
        apiKeySecret: "-----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----",
        walletSecret: "wallet-secret",
      });
    },
  );
});
