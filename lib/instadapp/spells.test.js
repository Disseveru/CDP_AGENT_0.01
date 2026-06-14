const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRecipe,
  listRecipes,
  parseSpellsInput,
  resolveDsaChainId,
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
