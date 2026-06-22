const { buildFlashBorrowAndCastSpells } = require("./flashloan");
const { getProtocolAddresses } = require("./protocols");
const { buildSwapAggregatorSellSpell, computeUnitAmt } = require("./quoter");

/**
 * @typedef {{ connector: string, method: string, args: unknown[] }} SpellInput
 */

/**
 * @param {unknown} value
 * @param {Record<string, string>} context
 */
function substituteTemplate(value, context) {
  if (value == null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => substituteTemplate(item, context));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substituteTemplate(item, context)]),
    );
  }

  if (typeof value !== "string") {
    return value;
  }

  const exact = value.match(/^\{\{(.+)\}\}$/);
  if (exact) {
    return context[exact[1]] ?? value;
  }

  return value.replace(/\{\{(.+?)\}\}/g, (_, key) =>
    context[key] !== undefined ? String(context[key]) : `{{${key}}}`,
  );
}

/**
 * @param {SpellInput[]} steps
 * @param {Record<string, string>} context
 * @returns {SpellInput[]}
 */
function materializeSteps(steps, context) {
  return steps.map((step) => ({
    connector: String(substituteTemplate(step.connector, context)),
    method: String(substituteTemplate(step.method, context)),
    args: substituteTemplate(step.args, context),
  }));
}

/**
 * @param {import("dsa-connect").DSA} dsa
 * @param {object} opportunity
 * @returns {SpellInput[]}
 */
function buildOpportunitySpells(dsa, opportunity) {
  const chainId = Number(opportunity.chainId);
  const protocols = getProtocolAddresses(chainId);
  const route = Number(opportunity.flashloanRoute ?? protocols.flashloanRoute);

  const context = {
    borrower: opportunity.borrower,
    market: opportunity.market,
    tokenIn: opportunity.tokenIn,
    tokenOut: opportunity.tokenOut,
    repayToken: opportunity.repayToken || opportunity.tokenIn,
    collateralToken: opportunity.collateralToken || opportunity.tokenOut,
    flashLoanAmountWei: String(opportunity.flashLoanAmountWei),
    unitAmtForward: opportunity.unitAmtForward,
    unitAmtReverse: opportunity.unitAmtReverse,
    fee: String(opportunity.fee ?? 500),
  };

  if (opportunity.type === "arbitrage") {
    const inner = [
      buildSwapAggregatorSellSpell({
        buyToken: context.tokenOut,
        sellToken: context.tokenIn,
        sellAmountWei: context.flashLoanAmountWei,
        unitAmt: context.unitAmtForward,
        fee: Number(context.fee),
      }),
      buildSwapAggregatorSellSpell({
        buyToken: context.tokenIn,
        sellToken: context.tokenOut,
        sellAmountWei: "{{forwardOutWei}}",
        unitAmt: context.unitAmtReverse,
        fee: Number(context.fee),
      }),
    ];

    const resolvedInner = materializeSteps(inner, {
      ...context,
      forwardOutWei: String(opportunity.forwardOutWei),
    });

    return buildFlashBorrowAndCastSpells(dsa, resolvedInner, {
      token: context.repayToken,
      amountWei: context.flashLoanAmountWei,
      route,
    });
  }

  if (opportunity.type === "liquidation" && opportunity.protocol === "compound-v3") {
    const inner = materializeSteps(
      [
        {
          connector: "COMPOUND-V3-A",
          method: "buyCollateral",
          args: [
            "{{market}}",
            "{{repayToken}}",
            "{{collateralToken}}",
            "{{unitAmtForward}}",
            "{{flashLoanAmountWei}}",
            0,
            0,
          ],
        },
        buildSwapAggregatorSellSpell({
          buyToken: context.repayToken,
          sellToken: context.collateralToken,
          sellAmountWei: "{{collateralReceivedWei}}",
          unitAmt: context.unitAmtReverse,
          fee: Number(context.fee),
        }),
      ],
      {
        ...context,
        collateralReceivedWei: String(opportunity.collateralReceivedWei || opportunity.flashLoanAmountWei),
      },
    );

    return buildFlashBorrowAndCastSpells(dsa, inner, {
      token: context.repayToken,
      amountWei: context.flashLoanAmountWei,
      route,
    });
  }

  throw new Error(
    `Unsupported opportunity type "${opportunity.type}"${opportunity.protocol ? ` (${opportunity.protocol})` : ""}.`,
  );
}

/**
 * Enriches an arbitrage opportunity with swap unit amounts.
 *
 * @param {object} opportunity
 * @param {import("web3").Web3} web3
 */
function enrichArbitrageUnits(opportunity, web3) {
  const forwardOut = BigInt(opportunity.forwardOutWei);
  return {
    ...opportunity,
    unitAmtForward: computeUnitAmt(BigInt(opportunity.flashLoanAmountWei), forwardOut),
    unitAmtReverse: computeUnitAmt(forwardOut, BigInt(opportunity.reverseOutWei)),
  };
}

module.exports = {
  buildOpportunitySpells,
  enrichArbitrageUnits,
  materializeSteps,
  substituteTemplate,
};
