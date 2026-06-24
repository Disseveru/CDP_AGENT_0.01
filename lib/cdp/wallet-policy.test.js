const assert = require("node:assert/strict");
const test = require("node:test");

const walletPolicy = require("./wallet-policy");

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

test("isLegacyWalletEnabled defaults on for cloud agents", () => {
  withEnv(
    {
      CURSOR_AGENT: "1",
      USE_LEGACY_WALLET: undefined,
      USE_EOA_WALLET: undefined,
      USE_SMART_WALLET: undefined,
    },
    () => {
      assert.equal(walletPolicy.isLegacyWalletEnabled(), true);
    },
  );
});

test("refuseNewWalletCreation throws unless explicitly allowed", () => {
  withEnv({ ALLOW_NEW_CDP_WALLET: undefined }, () => {
    assert.throws(() => walletPolicy.refuseNewWalletCreation("test"), /Refusing to create a new CDP wallet/);
  });

  withEnv({ ALLOW_NEW_CDP_WALLET: "1" }, () => {
    assert.doesNotThrow(() => walletPolicy.refuseNewWalletCreation("test"));
  });
});

test("resolveCanonicalPayToAddress prefers PAY_TO_ADDRESS override", () => {
  withEnv({ PAY_TO_ADDRESS: "0x0000000000000000000000000000000000000001" }, () => {
    assert.equal(
      walletPolicy.resolveCanonicalPayToAddress(),
      "0x0000000000000000000000000000000000000001",
    );
  });
});
