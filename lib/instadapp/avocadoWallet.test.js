const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildDsaAccountViaAvocado,
  isAvocadoEnabled,
  parseApiBalance,
  toAvocadoTransactions,
} = require("./avocadoWallet");

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

test("isAvocadoEnabled defaults to true", () => {
  withEnv({ DSA_USE_AVOCADO: undefined }, () => {
    assert.equal(isAvocadoEnabled(), true);
  });
});

test("isAvocadoEnabled can be disabled", () => {
  withEnv({ DSA_USE_AVOCADO: "0" }, () => {
    assert.equal(isAvocadoEnabled(), false);
  });
});

test("toAvocadoTransactions maps DSA actions", () => {
  const txs = toAvocadoTransactions([
    {
      target: "0xabc",
      data: "0x01",
      value: 0,
      operation: 1,
    },
  ]);

  assert.equal(txs[0].to, "0xabc");
  assert.equal(txs[0].operation, 1);
});

test("parseApiBalance reads Avocado api_getBalance hex", () => {
  assert.equal(parseApiBalance("0x69ec164fb02b4000"), 7632500000000000000n);
  assert.equal(parseApiBalance("0x0"), 0n);
});

test("buildDsaAccountViaAvocado registers the Avocado safe as DSA authority", async () => {
  const ownerAddress = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  const safeAddress = "0x1234567890123456789012345678901234567890";
  let capturedAuthority;
  const originalFetch = global.fetch;

  global.fetch = async () => ({
    json: async () => ({ result: "0x69ec164fb02b4000" }),
  });

  const dsa = {
    buildTransactionConfig: async (params) => {
      capturedAuthority = params.authority;
      return { to: "0xindex", data: "0xdeadbeef", value: 0, gas: "273126" };
    },
  };

  const web3 = {
    eth: {
      getGasPrice: async () => "1000000",
    },
  };

  const safe = {
    sendTransactions: async () => ({ hash: "0xabc" }),
  };

  try {
    await buildDsaAccountViaAvocado(dsa, web3, safe, safeAddress, 8453, { ownerAddress });
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(capturedAuthority, safeAddress);
});
