const { buildSpellInstance } = require("./spells");
const { applyFlashloanFee } = require("./protocols");

/**
 * @typedef {{ connector: string, method: string, args: unknown[] }} SpellInput
 */

/**
 * Builds inner spells for a flash loan (excluding the borrow wrapper).
 * Appends flashPayback when missing.
 *
 * @param {SpellInput[]} innerSpells
 * @param {{ token: string, amountWei: string, feeBps?: number }} payback
 * @returns {SpellInput[]}
 */
function withFlashPayback(innerSpells, payback) {
  const spells = [...innerSpells];
  const hasPayback = spells.some(
    (spell) =>
      spell.connector === "INSTAPOOL-C" &&
      (spell.method === "flashPayback" || spell.method === "flashMultiPayback"),
  );

  if (!hasPayback) {
    const paybackAmount = applyFlashloanFee(payback.amountWei, payback.feeBps).toString();
    spells.push({
      connector: "INSTAPOOL-C",
      method: "flashPayback",
      args: [payback.token, paybackAmount, 0, 0],
    });
  }

  return spells;
}

/**
 * Encodes inner spells and wraps them in INSTAPOOL-C.flashBorrowAndCast.
 * Requires `dsa.setInstance()` before calling.
 *
 * @param {import("dsa-connect").DSA} dsa
 * @param {SpellInput[]} innerSpells
 * @param {{ token: string, amountWei: string, route: number, extraData?: string, feeBps?: number }} flashLoan
 * @returns {SpellInput[]}
 */
function buildFlashBorrowAndCastSpells(dsa, innerSpells, flashLoan) {
  const wrappedInner = withFlashPayback(innerSpells, {
    token: flashLoan.token,
    amountWei: flashLoan.amountWei,
    feeBps: flashLoan.feeBps,
  });

  const innerInstance = buildSpellInstance(dsa, wrappedInner);
  const encodedData = dsa.instapool_v2.encodeFlashCastData(innerInstance);

  return [
    {
      connector: "INSTAPOOL-C",
      method: "flashBorrowAndCast",
      args: [
        flashLoan.token,
        flashLoan.amountWei,
        flashLoan.route,
        encodedData,
        flashLoan.extraData || "0x",
      ],
    },
  ];
}

module.exports = {
  buildFlashBorrowAndCastSpells,
  withFlashPayback,
};
