#!/usr/bin/env node
/**
 * Build Avocado Transaction Builder batch JSON for flash-loan arbitrage shortcuts.
 *
 * Usage:
 *   node scripts/build-avocado-arbitrage-batch.mjs --chainId 8453
 *   node scripts/build-avocado-arbitrage-batch.mjs --chainId 42161 --receiver 0x...
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const { getProtocolAddresses } = require("../lib/instadapp/protocols");
const { getTokenAddress } = require("../lib/instadapp/tokens");

const DEPLOYMENTS_PATH = path.join(process.cwd(), "deployments", "flash-contracts.json");
const OUTPUT_DIR = path.join(process.cwd(), "deployments", "avocado-batches");

const FLASH_AGGREGATORS = {
  8453: "0x3813f7a28814bfaf861192d0a5a4891b15698bac",
  42161: "0x1f882522DF99820dF8e586b6df8bAae2b91a782d",
};

const FLASH_LOAN_ABI = [
  "function flashLoan(address[] tokens, uint256[] amounts, uint256 route, bytes data, bytes instaData)",
];

const RECEIVER_ABI = [
  "function requestFlashLoan(address[] tokens, uint256[] amounts, uint256 route, bytes data)",
];

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return flags;
}

/**
 * @param {number} chainId
 * @param {string} [receiverOverride]
 */
function loadReceiverAddress(chainId, receiverOverride) {
  if (receiverOverride) {
    return receiverOverride;
  }

  if (!fs.existsSync(DEPLOYMENTS_PATH)) {
    throw new Error(`Missing ${DEPLOYMENTS_PATH}. Run scripts/deploy-flash-contracts.mjs first.`);
  }

  const manifest = JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, "utf8"));
  const entry = manifest[String(chainId)]?.flashLoanReceiver?.address;
  if (!entry) {
    throw new Error(`No deployed FlashLoanReceiver for chain ${chainId}.`);
  }
  return entry;
}

/**
 * @param {number} chainId
 * @param {string} receiverAddress
 * @param {string} safeAddress
 */
function buildArbitrageBatch(chainId, receiverAddress, safeAddress) {
  const protocols = getProtocolAddresses(chainId);
  const usdc = getTokenAddress(chainId, "USDC");
  const weth = getTokenAddress(chainId, "WETH");
  const aggregator = FLASH_AGGREGATORS[chainId];
  const route = protocols.flashloanRoute;

  const flashAmount = ethers.utils.parseUnits("5000", 6);
  const receiverIface = new ethers.utils.Interface(RECEIVER_ABI);
  const aggregatorIface = new ethers.utils.Interface(FLASH_LOAN_ABI);

  // Placeholder swap callback: no-op target. Replace with DEX router calldata in production.
  const callbackData = ethers.utils.defaultAbiCoder.encode(
    ["address", "bytes"],
    ["0x0000000000000000000000000000000000000000", "0x"],
  );

  const requestData = receiverIface.encodeFunctionData("requestFlashLoan", [
    [usdc],
    [flashAmount],
    route,
    callbackData,
  ]);

  const aggregatorData = aggregatorIface.encodeFunctionData("flashLoan", [
    [usdc],
    [flashAmount],
    route,
    ethers.utils.defaultAbiCoder.encode(
      ["address", "bytes"],
      [receiverAddress, callbackData],
    ),
    "0x",
  ]);

  const batch = {
    name: `flash-arbitrage-usdc-weth-${chainId}`,
    description:
      "Multi-step flash-loan arbitrage template on Instadapp aggregator. " +
      "Configure swap router calldata in the receiver callback before execution.",
    chainId,
    avocadoSafe: safeAddress,
    flashLoanReceiver: receiverAddress,
    flashAggregator: aggregator,
    route,
    tokens: { usdc, weth },
    transactions: [
      {
        label: "1-request-flash-loan-via-receiver",
        to: receiverAddress,
        operation: "call",
        value: "0",
        data: requestData,
      },
      {
        label: "2-direct-aggregator-flashloan-fallback",
        to: aggregator,
        operation: "call",
        value: "0",
        data: aggregatorData,
        note: "Use this step only when calling aggregator directly from Avocado safe.",
      },
    ],
    shortcut: {
      title: `Flash Arb USDC/WETH (${chainId === 8453 ? "Base" : "Arbitrum"})`,
      network: chainId === 8453 ? "Base" : "Arbitrum",
      steps: 1,
      primaryTx: {
        to: receiverAddress,
        data: requestData,
        value: "0",
        operation: 0,
      },
    },
  };

  return batch;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const chainId = Number(flags.chainId || 8453);
  const safeAddress =
    flags.safe || process.env.AVOCADO_SAFE_ADDRESS || "0xfd6C286dF0126f5D329526996242738d7200B40C";
  const receiverAddress = loadReceiverAddress(chainId, flags.receiver);

  const batch = buildArbitrageBatch(chainId, receiverAddress, safeAddress);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, `flash-arbitrage-${chainId}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(batch, null, 2)}\n`);

  console.log(JSON.stringify({ outPath, batch }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
