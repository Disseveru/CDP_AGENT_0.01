#!/usr/bin/env node
/**
 * Broadcast a flash-loan cast via Avocado RPC (V3 payload) without the broken SDK sendTransactions path.
 */

const { ethers } = require("ethers");
const { resolveSigningKey } = require("../lib/instadapp/keys");
const { getTokenAddress } = require("../lib/instadapp/tokens");
const { getProtocolAddresses } = require("../lib/instadapp/protocols");
const { resolveChainRpcUrl } = require("../lib/cdp/paymasterGas");

const AVOCADO_RPC = "https://rpc.avocado.instadapp.io";
const AVOCADO_CHAIN_ID = 634;
const SAFE =
  process.env.AVOCADO_SAFE_ADDRESS || "0xfd6C286dF0126f5D329526996242738d7200B40C";
const RECEIVER =
  process.env.FLASH_RECEIVER || "0xf5d25d1f85288b1ee7946307b480368d6a525d38";
const TARGET_CHAIN_ID = Number(process.env.DSA_CHAIN_ID || 8453);
const FLASH_AMOUNT_USDC = process.env.FLASH_AMOUNT_USDC || "50000";

const FORWARDER_ADDRESS = "0x375F6B0CD12b34Dc28e34C26853a37012C24dDE5";

const FORWARDER_ABI = [
  "function avoMultisigVersion(address) view returns (string)",
  "function avoMultisigVersionName(address) view returns (string)",
];

const SAFE_ABI = [
  "function avoNonce() view returns (int256)",
  "function owner() view returns (address)",
  "function DOMAIN_SEPARATOR_VERSION() view returns (string)",
  "function DOMAIN_SEPARATOR_NAME() view returns (string)",
];

const TYPES = {
  Cast: [
    { name: "params", type: "CastParams" },
    { name: "forwardParams", type: "CastForwardParams" },
  ],
  CastParams: [
    { name: "actions", type: "Action[]" },
    { name: "id", type: "uint256" },
    { name: "avoNonce", type: "int256" },
    { name: "salt", type: "bytes32" },
    { name: "source", type: "address" },
    { name: "metadata", type: "bytes" },
  ],
  Action: [
    { name: "target", type: "address" },
    { name: "data", type: "bytes" },
    { name: "value", type: "uint256" },
    { name: "operation", type: "uint256" },
  ],
  CastForwardParams: [
    { name: "gas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validUntil", type: "uint256" },
    { name: "value", type: "uint256" },
  ],
};

async function avocadoRpc(method, params = []) {
  const response = await fetch(AVOCADO_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload.error) {
    throw new Error(`${method}: ${payload.error.message || JSON.stringify(payload.error)}`);
  }
  return payload.result;
}

function encodeRequestFlashLoan(chainId, amountUsdc, route) {
  const usdc = getTokenAddress(chainId, "USDC");
  const amount = ethers.utils.parseUnits(String(amountUsdc), 6);
  const callbackData = ethers.utils.defaultAbiCoder.encode(
    ["address", "bytes"],
    ["0x0000000000000000000000000000000000000000", "0x"],
  );
  const iface = new ethers.utils.Interface([
    "function requestFlashLoan(address[] tokens, uint256[] amounts, uint256 route, bytes data)",
  ]);
  return iface.encodeFunctionData("requestFlashLoan", [[usdc], [amount], route, callbackData]);
}

async function main() {
  const route = getProtocolAddresses(TARGET_CHAIN_ID).flashloanRoute === 1 ? 5 : getProtocolAddresses(TARGET_CHAIN_ID).flashloanRoute;
  const data = encodeRequestFlashLoan(TARGET_CHAIN_ID, FLASH_AMOUNT_USDC, route);

  const avocadoProvider = new ethers.providers.JsonRpcProvider(AVOCADO_RPC, {
    chainId: AVOCADO_CHAIN_ID,
    name: "avocado",
  });
  const baseProvider = new ethers.providers.JsonRpcProvider(resolveChainRpcUrl(TARGET_CHAIN_ID), {
    chainId: TARGET_CHAIN_ID,
    name: "base",
  });

  const wallet = new ethers.Wallet(resolveSigningKey(), avocadoProvider);
  const owner = wallet.address;

  const forwarder = new ethers.Contract(FORWARDER_ADDRESS, FORWARDER_ABI, baseProvider);
  const safe = new ethers.Contract(SAFE, SAFE_ABI, baseProvider);

  let domainVersion;
  let domainName;
  try {
    [domainVersion, domainName] = await Promise.all([
      safe.DOMAIN_SEPARATOR_VERSION(),
      safe.DOMAIN_SEPARATOR_NAME(),
    ]);
  } catch {
    [domainVersion, domainName] = await Promise.all([
      forwarder.avoMultisigVersion(owner),
      forwarder.avoMultisigVersionName(owner),
    ]);
  }

  const avoNonce = await safe.avoNonce();
  const safeOwner = await safe.owner();

  if (safeOwner.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Signer ${owner} is not owner of safe ${SAFE} (owner ${safeOwner})`);
  }

  const now = Math.floor(Date.now() / 1000);
  const txPayload = {
    params: {
      actions: [
        {
          target: RECEIVER,
          data,
          value: "0",
          operation: "0",
        },
      ],
      id: "20",
      avoNonce: avoNonce.toString(),
      salt: ethers.utils.defaultAbiCoder.encode(["uint256"], [Date.now()]),
      source: "0x000000000000000000000000000000000000Cad0",
      metadata: "0x",
    },
    forwardParams: {
      gas: "0",
      gasPrice: "0",
      validAfter: "0",
      validUntil: String(now + 3600),
      value: "0",
    },
  };

  const domain = {
    name: domainName,
    version: domainVersion,
    chainId: AVOCADO_CHAIN_ID,
    verifyingContract: SAFE,
    salt: ethers.utils.solidityKeccak256(["uint256"], [TARGET_CHAIN_ID]),
  };

  const signature = await wallet._signTypedData(domain, TYPES, txPayload);

  const txHash = await avocadoRpc("txn_broadcast", [
    {
      signatures: [{ signature, signer: owner }],
      message: txPayload,
      owner,
      safe: SAFE,
      index: "0",
      targetChainId: String(TARGET_CHAIN_ID),
    },
  ]);

  console.log(
    JSON.stringify(
      {
        success: true,
        txHash,
        safe: SAFE,
        receiver: RECEIVER,
        route,
        flashAmountUsdc: FLASH_AMOUNT_USDC,
        basescan: `https://basescan.org/tx/${txHash}`,
        owner,
        domainVersion,
        domainName,
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
