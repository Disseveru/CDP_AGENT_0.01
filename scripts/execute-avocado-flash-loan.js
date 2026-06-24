#!/usr/bin/env node
/**
 * Execute flash-loan via Avocado Transaction Builder path (safe.sendTransactions).
 * Gas is paid from the Avocado USDC gas tank on Base.
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const {
  createAvocadoWallet,
  ensureAvocadoGas,
  getAvocadoGasBalanceForAddress,
  resolveAvocadoSafeAddress,
} = require("../lib/instadapp/avocadoWallet");
const { getTokenAddress } = require("../lib/instadapp/tokens");
const { getProtocolAddresses } = require("../lib/instadapp/protocols");

const SAFE = process.env.AVOCADO_SAFE_ADDRESS || "0xfd6C286dF0126f5D329526996242738d7200B40C";
const CHAIN_ID = Number(process.env.DSA_CHAIN_ID || 8453);
const DEPLOYMENTS_PATH = path.join(process.cwd(), "deployments", "flash-contracts.json");

const RECEIVER_ABI = [
  "function owner() view returns (address)",
  "function setOwner(address newOwner)",
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

function loadReceiverAddress() {
  const manifest = JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, "utf8"));
  return manifest[String(CHAIN_ID)]?.flashLoanReceiver?.address;
}

function encodeRequestFlashLoan(amountUsdc) {
  const usdc = getTokenAddress(CHAIN_ID, "USDC");
  const route = getProtocolAddresses(CHAIN_ID).flashloanRoute;
  const amount = ethers.utils.parseUnits(String(amountUsdc), 6);
  const callbackData = ethers.utils.defaultAbiCoder.encode(
    ["address", "bytes"],
    ["0x0000000000000000000000000000000000000000", "0x"],
  );
  const iface = new ethers.utils.Interface(RECEIVER_ABI);
  return {
    usdc,
    route,
    amount: amount.toString(),
    data: iface.encodeFunctionData("requestFlashLoan", [[usdc], [amount], route, callbackData]),
  };
}

async function sendFromSafe(safe, safeAddress, transactions, flashLoan = false) {
  await ensureAvocadoGas(safe, safeAddress);
  return safe.sendTransactions(transactions, CHAIN_ID, {
    safeAddress,
    id: flashLoan ? "20" : "0",
  });
}

async function ensureSafeOwnsReceiver(provider, receiverAddress, safeAddress) {
  const receiver = new ethers.Contract(receiverAddress, RECEIVER_ABI, provider);
  const owner = await receiver.owner();
  if (owner.toLowerCase() === safeAddress.toLowerCase()) {
    return { ready: true, owner };
  }

  throw new Error(
    `FlashLoanReceiver owner is ${owner}, expected Avocado safe ${safeAddress}. ` +
      "Transfer ownership from the EOA or deploy a receiver with FLASH_CONTRACT_OWNER set to the safe.",
  );
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const dryRun = Boolean(flags["dry-run"]);
  const amountUsdc = Number(flags.amount || 50000);
  const receiverAddress = flags.receiver || loadReceiverAddress();

  if (!receiverAddress) {
    throw new Error("Missing FlashLoanReceiver address.");
  }

  process.env.AVOCADO_SAFE_ADDRESS = SAFE;
  const safeAddress = (await resolveAvocadoSafeAddress()) || SAFE;
  const gas = await getAvocadoGasBalanceForAddress(safeAddress);
  const { safe, provider } = createAvocadoWallet(undefined, safeAddress);
  const encoded = encodeRequestFlashLoan(amountUsdc);

  console.log(
    JSON.stringify(
      {
        chainId: CHAIN_ID,
        safeAddress,
        gasBalanceUsdc: gas.balanceHuman,
        receiverAddress,
        flashAmountUsdc: amountUsdc,
        calldata: encoded.data,
      },
      null,
      2,
    ),
  );

  if (dryRun) {
    return;
  }

  const ownership = await ensureSafeOwnsReceiver(provider, receiverAddress, safeAddress);
  console.log("ownership:", ownership);

  const response = await sendFromSafe(
    safe,
    safeAddress,
    [{ to: receiverAddress, data: encoded.data, value: 0 }],
    true,
  );

  console.log(
    JSON.stringify(
      {
        success: true,
        txHash: response.hash,
        safeAddress,
        receiverAddress,
        amountUsdc,
        basescan: `https://basescan.org/tx/${response.hash}`,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
