const assert = require("node:assert/strict");
const test = require("node:test");

const { resolvePersistedDsaId, resolveEffectiveAuthorityAddress } = require("./client");
const { resolveSigningKey } = require("./keys");

const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const EXPECTED_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

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

test("resolveSigningKey derives a private key from MNEMONIC_PHRASE", () => {
  withEnv(
    {
      MNEMONIC_PHRASE: TEST_MNEMONIC,
      DSA_PRIVATE_KEY: undefined,
      PRIVATE_KEY: undefined,
    },
    () => {
      const privateKey = resolveSigningKey("/nonexistent/wallet_data.txt");
      assert.match(privateKey, /^0x[0-9a-f]{64}$/i);

      const Web3 = require("web3");
      const web3 = new Web3();
      assert.equal(web3.eth.accounts.privateKeyToAccount(privateKey).address, EXPECTED_ADDRESS);
    },
  );
});

test("resolveSigningKey accepts mnemonic phrases in DSA_PRIVATE_KEY", () => {
  withEnv(
    {
      DSA_PRIVATE_KEY: TEST_MNEMONIC,
      MNEMONIC_PHRASE: undefined,
      PRIVATE_KEY: undefined,
    },
    () => {
      const privateKey = resolveSigningKey("/nonexistent/wallet_data.txt");
      assert.match(privateKey, /^0x[0-9a-f]{64}$/i);

      const Web3 = require("web3");
      const web3 = new Web3();
      assert.equal(web3.eth.accounts.privateKeyToAccount(privateKey).address, EXPECTED_ADDRESS);
    },
  );
});

test("resolveSigningKey accepts mnemonic phrases in wallet_data.txt seed", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  const walletDataPath = path.join(os.tmpdir(), `dsa-wallet-data-${Date.now()}.txt`);
  fs.writeFileSync(walletDataPath, JSON.stringify({ seed: TEST_MNEMONIC }), "utf8");

  withEnv(
    {
      DSA_PRIVATE_KEY: undefined,
      MNEMONIC_PHRASE: undefined,
      PRIVATE_KEY: undefined,
    },
    () => {
      const privateKey = resolveSigningKey(walletDataPath);
      assert.match(privateKey, /^0x[0-9a-f]{64}$/i);

      const Web3 = require("web3");
      const web3 = new Web3();
      assert.equal(web3.eth.accounts.privateKeyToAccount(privateKey).address, EXPECTED_ADDRESS);
    },
  );

  fs.unlinkSync(walletDataPath);
});

test("ensureDsaInstance must use resolvePersistedDsaId, not raw chainState.dsaId", () => {
  const oldSigner = "0xOldSigner000000000000000000000000001";
  const newSigner = "0xNewSigner000000000000000000000000001";
  const state = {
    signerAddress: oldSigner,
    chains: {
      "8453": { dsaId: 42, dsaAddress: "0xBaseDsa" },
    },
  };

  const staleChainId = state.chains["8453"].dsaId;
  assert.equal(staleChainId, 42);
  assert.equal(resolvePersistedDsaId(state, 8453, newSigner), undefined);
});

test("resolveEffectiveAuthorityAddress prefers persisted Avocado safe over auto-pick", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");

  const dataPath = path.join(os.tmpdir(), `dsa-state-${Date.now()}.json`);
  fs.writeFileSync(
    dataPath,
    `${JSON.stringify(
      {
        signerAddress: "0xAbC000000000000000000000000000000000001",
        chains: {
          "8453": {
            dsaId: 42,
            dsaAddress: "0xBaseDsa",
            authorityAddress: "0xSafeA00000000000000000000000000000000001",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const autoPick = "0xSafeB00000000000000000000000000000000002";
  const originalFetch = global.fetch;

  global.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body || "{}"));
    if (body.method === "api_getSafes") {
      return {
        json: async () => ({
          result: {
            data: [
              { safe_address: autoPick, owner_address: "0xAbC000000000000000000000000000000000001" },
              { safe_address: "0xSafeA00000000000000000000000000000000001", owner_address: "0xAbC000000000000000000000000000000000001" },
            ],
          },
        }),
      };
    }

    if (body.method === "api_getBalance") {
      const safeAddress = body.params?.[0];
      const balance =
        safeAddress === autoPick ? "0x69ec164fb02b4000" : "0x0";
      return { json: async () => ({ result: balance }) };
    }

    throw new Error(`Unexpected Avocado RPC ${body.method}`);
  };

  try {
    await withEnvAsync(
      {
        DSA_USE_AVOCADO: undefined,
        AVOCADO_SAFE_ADDRESS: undefined,
        DSA_AVOCADO_SAFE: undefined,
        DSA_AVOCADO_SAFE_ADDRESS: undefined,
      },
      async () => {
        const authorityAddress = await resolveEffectiveAuthorityAddress(8453, { dataPath });
        assert.equal(authorityAddress, "0xSafeA00000000000000000000000000000000001");
      },
    );
  } finally {
    global.fetch = originalFetch;
    fs.unlinkSync(dataPath);
  }
});

async function withEnvAsync(overrides, run) {
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
    await run();
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
