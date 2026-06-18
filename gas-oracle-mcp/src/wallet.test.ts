import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveCdpApiCredentials, resolveCdpCredentials } from "./wallet.js";

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXED_PAY_TO_ADDRESS = "0xed7d30e8bc643503f9da261ed8e623bb6ecf6189";

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

function generatePrivateKeys(): { pkcs8Pem: string; pkcs8DerBase64: string; sec1Pem: string } {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    pkcs8Pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    pkcs8DerBase64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    sec1Pem: privateKey.export({ format: "pem", type: "sec1" }).toString(),
  };
}

function assertPkcs8Pem(secret: string): void {
  assert.match(secret, /BEGIN PRIVATE KEY/);
  assert.doesNotThrow(() => crypto.createPrivateKey({ key: secret, format: "pem", type: "pkcs8" }));
}

test("resolveCdpCredentials accepts standard CDP SDK alias names", { concurrency: false }, () => {
  const { pkcs8Pem } = generatePrivateKeys();
  withEnv(
    {
      CDP_API_KEY: undefined,
      CDP_PRIVATE_KEY: undefined,
      CDP_API_KEY_ID: "alias-key-id",
      CDP_API_KEY_SECRET: pkcs8Pem.replace(/\n/g, "\\n"),
      CDP_WALLET_SECRET: "wallet-secret",
    },
    () => {
      const credentials = resolveCdpCredentials();
      assert.equal(credentials.apiKeyId, "alias-key-id");
      assert.equal(credentials.walletSecret, "wallet-secret");
      assertPkcs8Pem(credentials.apiKeySecret);
    },
  );
});

test("resolveCdpCredentials keeps canonical variable support", { concurrency: false }, () => {
  const { pkcs8Pem } = generatePrivateKeys();
  withEnv(
    {
      CDP_API_KEY: "primary-key-id",
      CDP_PRIVATE_KEY: pkcs8Pem.replace(/\n/g, "\\n"),
      CDP_API_KEY_ID: undefined,
      CDP_API_KEY_SECRET: undefined,
      CDP_WALLET_SECRET: "wallet-secret",
    },
    () => {
      const credentials = resolveCdpCredentials();
      assert.equal(credentials.apiKeyId, "primary-key-id");
      assert.equal(credentials.walletSecret, "wallet-secret");
      assertPkcs8Pem(credentials.apiKeySecret);
    },
  );
});

test("resolveCdpCredentials strips wrapping quotes around escaped PEM secrets", { concurrency: false }, () => {
  const { pkcs8Pem } = generatePrivateKeys();
  withEnv(
    {
      CDP_API_KEY: undefined,
      CDP_PRIVATE_KEY: undefined,
      CDP_API_KEY_ID: "quoted-key-id",
      CDP_API_KEY_SECRET: JSON.stringify(pkcs8Pem.replace(/\n/g, "\\n")),
      CDP_WALLET_SECRET: "wallet-secret",
    },
    () => {
      const credentials = resolveCdpCredentials();
      assert.equal(credentials.apiKeyId, "quoted-key-id");
      assertPkcs8Pem(credentials.apiKeySecret);
    },
  );
});

test("resolveCdpCredentials accepts base64 DER secrets without PEM wrappers", { concurrency: false }, () => {
  const { pkcs8DerBase64 } = generatePrivateKeys();
  withEnv(
    {
      CDP_API_KEY: "der-key-id",
      CDP_PRIVATE_KEY: pkcs8DerBase64,
      CDP_API_KEY_ID: undefined,
      CDP_API_KEY_SECRET: undefined,
      CDP_WALLET_SECRET: "wallet-secret",
    },
    () => {
      const credentials = resolveCdpCredentials();
      assert.equal(credentials.apiKeyId, "der-key-id");
      assertPkcs8Pem(credentials.apiKeySecret);
    },
  );
});

test("resolveCdpCredentials converts SEC1 EC keys to PKCS8", { concurrency: false }, () => {
  const { sec1Pem } = generatePrivateKeys();
  withEnv(
    {
      CDP_API_KEY: "sec1-key-id",
      CDP_PRIVATE_KEY: sec1Pem.replace(/\n/g, "\\n"),
      CDP_API_KEY_ID: undefined,
      CDP_API_KEY_SECRET: undefined,
      CDP_WALLET_SECRET: "wallet-secret",
    },
    () => {
      const credentials = resolveCdpCredentials();
      assert.equal(credentials.apiKeyId, "sec1-key-id");
      assertPkcs8Pem(credentials.apiKeySecret);
      assert.doesNotMatch(credentials.apiKeySecret, /BEGIN EC PRIVATE KEY/);
    },
  );
});

test("resolveCdpApiCredentials accepts API key aliases without wallet secret", { concurrency: false }, () => {
  const { pkcs8Pem } = generatePrivateKeys();
  withEnv(
    {
      CDP_API_KEY: undefined,
      CDP_PRIVATE_KEY: undefined,
      CDP_API_KEY_ID: "alias-key-id",
      CDP_API_KEY_SECRET: pkcs8Pem.replace(/\n/g, "\\n"),
      CDP_WALLET_SECRET: undefined,
    },
    () => {
      const credentials = resolveCdpApiCredentials();
      assert.ok(credentials);
      assert.equal(credentials?.apiKeyId, "alias-key-id");
      assertPkcs8Pem(credentials!.apiKeySecret);
    },
  );
});

test("resolveCdpApiCredentials returns undefined for malformed private keys", { concurrency: false }, () => {
  withEnv(
    {
      CDP_API_KEY: "broken-key-id",
      CDP_PRIVATE_KEY: "'not-a-real-private-key'",
      CDP_API_KEY_ID: undefined,
      CDP_API_KEY_SECRET: undefined,
    },
    () => {
      assert.equal(resolveCdpApiCredentials(), undefined);
    },
  );
});

test("createCdpFacilitatorConfig uses the sellers quickstart facilitator URL", { concurrency: false }, () => {
  const script = `
    const { createCdpFacilitatorConfig } = await import("./src/payments.ts");
    console.log(createCdpFacilitatorConfig().url);
  `;

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
    },
  );

  assert.equal(
    result.status,
    0,
    `child process failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.equal(result.stdout.trim().split("\n").at(-1), "https://api.cdp.coinbase.com/platform/v2/x402");
});

test("PAY_TO_ADDRESS bypasses malformed CDP keys during wallet initialization", { concurrency: false }, () => {
  const script = `
    process.env.PAY_TO_ADDRESS = ${JSON.stringify(FIXED_PAY_TO_ADDRESS)};
    process.env.CDP_API_KEY = "broken-key-id";
    process.env.CDP_PRIVATE_KEY = "'not-a-real-private-key'";
    process.env.CDP_WALLET_SECRET = "wallet-secret";

    const { initializeOracleIdentity } = await import("./src/wallet.ts");
    const identity = await initializeOracleIdentity();
    console.log(JSON.stringify(identity));
  `;

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
    },
  );

  assert.equal(
    result.status,
    0,
    `child process failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  const identity = JSON.parse(result.stdout.trim().split("\n").at(-1) || "{}") as {
    address?: string;
    agentKit?: unknown;
  };

  assert.equal(identity.address, FIXED_PAY_TO_ADDRESS);
  assert.equal(identity.agentKit, null);
});

test("malformed CDP keys produce no facilitator auth headers", { concurrency: false }, () => {
  const script = `
    process.env.CDP_API_KEY = "broken-key-id";
    process.env.CDP_PRIVATE_KEY = "'not-a-real-private-key'";
    delete process.env.CDP_API_KEY_ID;
    delete process.env.CDP_API_KEY_SECRET;

    const { createCdpFacilitatorConfig } = await import("./src/payments.ts");
    const config = createCdpFacilitatorConfig();
    const headers = await config.createAuthHeaders?.();
    console.log(JSON.stringify(headers));
  `;

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
    },
  );

  assert.equal(
    result.status,
    0,
    `child process failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  const headers = JSON.parse(result.stdout.trim().split("\n").at(-1) || "{}") as Record<
    string,
    Record<string, string>
  >;

  assert.equal(headers.verify?.Authorization, undefined);
  assert.equal(headers.settle?.Authorization, undefined);
  assert.equal(headers.supported?.Authorization, undefined);
});

test("defaults to the CDP facilitator URL from the sellers quickstart", {
  concurrency: false,
}, () => {
  const script = `
    delete process.env.FACILITATOR_URL;

    const { CONFIG, CDP_FACILITATOR_URL } = await import("./src/config.ts");
    console.log(CONFIG.facilitatorUrl === CDP_FACILITATOR_URL ? CONFIG.facilitatorUrl : "mismatch");
  `;

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
    },
  );

  assert.equal(
    result.status,
    0,
    `child process failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.equal(result.stdout.trim().split("\n").at(-1), "https://api.cdp.coinbase.com/platform/v2/x402");
});
