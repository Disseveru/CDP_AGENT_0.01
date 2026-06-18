const assert = require("node:assert/strict");
const test = require("node:test");

const { resolveSigningKey } = require("./client");

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
