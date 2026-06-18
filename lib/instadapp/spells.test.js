const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRecipe,
  listRecipes,
  parseSpellsInput,
  resolveDsaChainId,
  resolvePersistedDsaId,
  validateSpell,
} = require("./index");

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

test("validateSpell accepts Instadapp connector IDs", () => {
  const spell = validateSpell({
    connector: "AAVE-V3-A",
    method: "deposit",
    args: ["0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", "1000", 0, 0],
  });

  assert.equal(spell.connector, "AAVE-V3-A");
  assert.equal(spell.method, "deposit");
  assert.equal(spell.args.length, 4);
});

test("validateSpell rejects shell metacharacters in connector names", () => {
  assert.throws(
    () =>
      validateSpell({
        connector: "AAVE;rm",
        method: "deposit",
        args: [],
      }),
    /Invalid connector/,
  );
});

test("parseSpellsInput parses JSON arrays", () => {
  const spells = parseSpellsInput(
    '[{"connector":"BASIC-A","method":"deposit","args":["0x00", "1", 0, 0]}]',
  );
  assert.equal(spells.length, 1);
  assert.equal(spells[0].connector, "BASIC-A");
});

test("buildRecipe composes deposit-eth-aave spells", () => {
  const spells = buildRecipe("deposit-eth-aave", { amountWei: "1000000000000000000" });
  assert.equal(spells.length, 2);
  assert.equal(spells[0].connector, "BASIC-A");
  assert.equal(spells[1].connector, "AAVE-V3-A");
});

test("listRecipes includes built-in recipes", () => {
  const recipes = listRecipes();
  assert.ok(recipes.some((recipe) => recipe.name === "deposit-eth"));
});

test("resolveDsaChainId defaults to Base mainnet", () => {
  withEnv({ DSA_CHAIN_ID: undefined }, () => {
    assert.equal(resolveDsaChainId(), 8453);
  });
});

test("resolveDsaChainId rejects Base Sepolia", () => {
  withEnv({ DSA_CHAIN_ID: "84532" }, () => {
    assert.throws(() => resolveDsaChainId(), /Unsupported DSA_CHAIN_ID/);
  });
});

test("resolvePersistedDsaId ignores stale dsaId after chain switch", () => {
  const signer = "0xAbC000000000000000000000000000000000001";
  const state = {
    chainId: 8453,
    dsaId: 42,
    dsaAddress: "0xBaseDsa",
    signerAddress: signer,
  };

  assert.equal(resolvePersistedDsaId(state, 8453, signer), 42);
  assert.equal(resolvePersistedDsaId(state, 137, signer), undefined);
});

test("resolvePersistedDsaId ignores stale dsaId after signer switch", () => {
  const state = {
    chainId: 8453,
    dsaId: 42,
    dsaAddress: "0xBaseDsa",
    signerAddress: "0xOldSigner000000000000000000000000001",
  };

  assert.equal(
    resolvePersistedDsaId(state, 8453, "0xNewSigner000000000000000000000000001"),
    undefined,
  );
});

test("resolvePersistedDsaId reads per-chain state", () => {
  const signer = "0xAbC000000000000000000000000000000000001";
  const state = {
    signerAddress: signer,
    chains: {
      "8453": { dsaId: 42, dsaAddress: "0xBaseDsa" },
      "137": { dsaId: 7, dsaAddress: "0xPolyDsa" },
    },
  };

  assert.equal(resolvePersistedDsaId(state, 8453, signer), 42);
  assert.equal(resolvePersistedDsaId(state, 137, signer), 7);
  assert.equal(resolvePersistedDsaId(state, 42161, signer), undefined);
});

test("resolvePersistedDsaId ignores dsaId when chain metadata is missing", () => {
  const signer = "0xAbC000000000000000000000000000000000001";
  const state = {
    dsaId: 42,
    dsaAddress: "0xBaseDsa",
    signerAddress: signer,
  };

  assert.equal(resolvePersistedDsaId(state, 8453, signer), undefined);
  assert.equal(resolvePersistedDsaId(state, 137, signer), undefined);
});

test("resolvePersistedDsaId ignores dsaId when signer metadata is missing", () => {
  const state = {
    chainId: 8453,
    dsaId: 42,
    dsaAddress: "0xBaseDsa",
  };

  assert.equal(
    resolvePersistedDsaId(state, 8453, "0xAbC000000000000000000000000000000000001"),
    undefined,
  );
});

test("resolvePersistedDsaId ignores per-chain dsaId when signer metadata is missing", () => {
  const state = {
    chains: {
      "8453": { dsaId: 42, dsaAddress: "0xBaseDsa" },
    },
  };

  assert.equal(
    resolvePersistedDsaId(state, 8453, "0xAbC000000000000000000000000000000000001"),
    undefined,
  );
});
