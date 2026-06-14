const { NATIVE_TOKEN } = require("./constants");

const CONNECTOR_PATTERN = /^[A-Z0-9][A-Z0-9_-]*$/;
const METHOD_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/**
 * @typedef {{ connector: string, method: string, args: unknown[] }} SpellInput
 */

/**
 * @param {unknown} spell
 * @returns {SpellInput}
 */
function validateSpell(spell) {
  if (!spell || typeof spell !== "object" || Array.isArray(spell)) {
    throw new Error("Each spell must be an object with connector, method, and args.");
  }

  const { connector, method, args } = spell;

  if (typeof connector !== "string" || !CONNECTOR_PATTERN.test(connector)) {
    throw new Error(`Invalid connector "${String(connector)}". Use IDs like AAVE-V3-A or BASIC-A.`);
  }

  if (typeof method !== "string" || !METHOD_PATTERN.test(method)) {
    throw new Error(`Invalid method "${String(method)}".`);
  }

  if (!Array.isArray(args)) {
    throw new Error(`Spell ${connector}.${method} requires an args array.`);
  }

  return { connector, method, args };
}

/**
 * @param {unknown} input
 * @returns {SpellInput[]}
 */
function parseSpellsInput(input) {
  let parsed = input;

  if (typeof input === "string") {
    parsed = JSON.parse(input);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Spells payload must be a JSON array of spell objects.");
  }

  if (parsed.length === 0) {
    throw new Error("At least one spell is required.");
  }

  return parsed.map(validateSpell);
}

/**
 * @param {import("dsa-connect").DSA} dsa
 * @param {SpellInput[]} spells
 */
function buildSpellInstance(dsa, spells) {
  const instance = dsa.Spell();

  for (const spell of spells) {
    instance.add(spell);
  }

  return instance;
}

/**
 * Built-in spell recipes for common Base mainnet flows.
 *
 * @type {Record<string, { description: string, build: (params?: Record<string, string>) => SpellInput[] }>}
 */
const RECIPES = {
  "deposit-eth": {
    description: "Deposit native ETH into the DSA via BASIC-A.",
    build: (params = {}) => {
      const amountWei = params.amountWei || params.amount;
      if (!amountWei) {
        throw new Error('Recipe "deposit-eth" requires amountWei (wei string).');
      }

      return [
        {
          connector: "BASIC-A",
          method: "deposit",
          args: [NATIVE_TOKEN, amountWei, 0, 0],
        },
      ];
    },
  },
  "deposit-eth-aave": {
    description: "Deposit ETH into the DSA, then supply to Aave V3 on Base.",
    build: (params = {}) => {
      const amountWei = params.amountWei || params.amount;
      if (!amountWei) {
        throw new Error('Recipe "deposit-eth-aave" requires amountWei (wei string).');
      }

      return [
        {
          connector: "BASIC-A",
          method: "deposit",
          args: [NATIVE_TOKEN, amountWei, 0, 0],
        },
        {
          connector: "AAVE-V3-A",
          method: "deposit",
          args: [NATIVE_TOKEN, amountWei, 0, 0],
        },
      ];
    },
  },
  "withdraw-eth": {
    description: "Withdraw native ETH from the DSA via BASIC-A.",
    build: (params = {}) => {
      const amountWei = params.amountWei || params.amount;
      if (!amountWei) {
        throw new Error('Recipe "withdraw-eth" requires amountWei (wei string).');
      }

      return [
        {
          connector: "BASIC-A",
          method: "withdraw",
          args: [NATIVE_TOKEN, amountWei, 0, params.to || "0x0000000000000000000000000000000000000000"],
        },
      ];
    },
  },
};

/**
 * @param {string} name
 * @param {Record<string, string>} [params]
 * @returns {SpellInput[]}
 */
function buildRecipe(name, params = {}) {
  const recipe = RECIPES[name];
  if (!recipe) {
    throw new Error(`Unknown recipe "${name}". Run "dsa recipes" to list options.`);
  }

  return recipe.build(params);
}

/**
 * @returns {{ name: string, description: string }[]}
 */
function listRecipes() {
  return Object.entries(RECIPES).map(([name, recipe]) => ({
    name,
    description: recipe.description,
  }));
}

module.exports = {
  RECIPES,
  buildRecipe,
  buildSpellInstance,
  listRecipes,
  parseSpellsInput,
  validateSpell,
};
