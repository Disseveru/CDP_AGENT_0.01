#!/usr/bin/env node
/**
 * Remove extra Avocado multisig signers and set requiredSigners to 1.
 *
 * Needs signatures from at least `requiredSigners` keys (currently 2-of-3).
 * Provide comma-separated private keys for any signers you control:
 *
 *   AVOCADO_SIGNER_KEYS=0xkey1,0xkey2,0xkey3 \
 *   node scripts/avocado-remove-multisig-signers.mjs
 *
 * Or use MNEMONIC_PHRASE / DSA_PRIVATE_KEY for one key plus:
 *   AVOCADO_SIGNER_KEY_2=0x... AVOCADO_SIGNER_KEY_3=0x...
 *
 * Options:
 *   --dry-run   simulate via txn_broadcast dryRun
 *   --chain-id  target chain (default 8453 Base)
 */
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { ethers } from "ethers";

const require = createRequire(import.meta.url);
const { resolveSigningKey, normalizePrivateKey } = require("../lib/instadapp/keys.js");

const AVOCADO_RPC = "https://rpc.avocado.instadapp.io";
const DEFAULT_SAFE = "0xfd6C286dF0126f5D329526996242738d7200B40C";

const SIGN_TYPES = {
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

const EXECUTION_TYPES = {
  ...SIGN_TYPES,
  Cast: [
    ...SIGN_TYPES.Cast,
    { name: "signatures", type: "SignatureParams[]" },
  ],
  SignatureParams: [
    { name: "signature", type: "bytes" },
    { name: "signer", type: "address" },
  ],
};

const { values: args } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    "chain-id": { type: "string", default: "8453" },
  },
});

function collectSignerKeys() {
  const keys = new Set();

  if (process.env.AVOCADO_SIGNER_KEYS) {
    for (const part of process.env.AVOCADO_SIGNER_KEYS.split(",")) {
      const trimmed = part.trim();
      if (trimmed) keys.add(normalizePrivateKey(trimmed));
    }
  }

  for (const name of ["AVOCADO_SIGNER_KEY_2", "AVOCADO_SIGNER_KEY_3", "AVOCADO_SIGNER_KEY_1"]) {
    if (process.env[name]) {
      keys.add(normalizePrivateKey(process.env[name]));
    }
  }

  try {
    keys.add(resolveSigningKey());
  } catch {
    // optional if AVOCADO_SIGNER_KEYS fully specified
  }

  return [...keys].map((pk) => new ethers.Wallet(pk));
}

async function avocadoRpc(method, params) {
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

async function readSafeConfig(provider, safeAddress) {
  const safe = new ethers.Contract(
    safeAddress,
    [
      "function avoNonce() view returns (int256)",
      "function requiredSigners() view returns (uint256)",
      "function signers() view returns (address[])",
      "function owner() view returns (address)",
      "function DOMAIN_SEPARATOR_NAME() view returns (string)",
      "function DOMAIN_SEPARATOR_VERSION() view returns (string)",
    ],
    provider,
  );

  const [avoNonce, requiredSigners, signers, owner, domainName, domainVersion] =
    await Promise.all([
      safe.avoNonce(),
      safe.requiredSigners(),
      safe.signers(),
      safe.owner(),
      safe.DOMAIN_SEPARATOR_NAME(),
      safe.DOMAIN_SEPARATOR_VERSION(),
    ]);

  return {
    avoNonce: avoNonce.toString(),
    requiredSigners: Number(requiredSigners.toString()),
    signers,
    owner,
    domainName,
    domainVersion,
  };
}

function buildRemoveSignersCalldata(safeAddress, signersToRemove, newRequired) {
  const sorted = [...signersToRemove].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  );
  const iface = new ethers.utils.Interface([
    "function removeSigners(address[] removeSigners_, uint8 requiredSigners_)",
  ]);
  return iface.encodeFunctionData("removeSigners", [sorted, newRequired]);
}

async function main() {
  const chainId = Number(args["chain-id"]);
  const safeAddress = process.env.AVOCADO_SAFE_ADDRESS || DEFAULT_SAFE;
  const wallets = collectSignerKeys();

  if (wallets.length === 0) {
    throw new Error("No signer keys found. Set MNEMONIC_PHRASE or AVOCADO_SIGNER_KEYS.");
  }

  const rpcUrl =
    chainId === 8453
      ? "https://mainnet.base.org"
      : chainId === 137
        ? "https://polygon.llamarpc.com"
        : process.env.DSA_RPC_URL;
  if (!rpcUrl) {
    throw new Error(`No default RPC for chain ${chainId}. Set DSA_RPC_URL.`);
  }

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const config = await readSafeConfig(provider, safeAddress);

  console.log("Safe:", safeAddress);
  console.log("Chain:", chainId);
  console.log("Owner:", config.owner);
  console.log("Current signers:", config.signers);
  console.log("Required signers:", config.requiredSigners);
  console.log("avoNonce:", config.avoNonce);
  console.log("Provided key addresses:", wallets.map((w) => w.address));

  const allowed = new Set(config.signers.map((s) => s.toLowerCase()));
  const usableWallets = wallets.filter((w) => allowed.has(w.address.toLowerCase()));

  if (usableWallets.length < config.requiredSigners) {
    throw new Error(
      `Need at least ${config.requiredSigners} signer private keys on this safe. ` +
        `Only matched ${usableWallets.length}: ${usableWallets.map((w) => w.address).join(", ") || "(none)"}`,
    );
  }

  const keepAddress = config.owner;
  const removeAddresses = config.signers.filter(
    (s) => s.toLowerCase() !== keepAddress.toLowerCase(),
  );

  if (removeAddresses.length === 0) {
    console.log("No extra signers to remove.");
    return;
  }

  console.log("\nWill remove:", removeAddresses);
  console.log("Keep only owner as signer; set requiredSigners to 1");

  const calldata = buildRemoveSignersCalldata(safeAddress, removeAddresses, 1);
  const txPayload = {
    params: {
      actions: [
        {
          target: safeAddress,
          data: calldata,
          value: "0",
          operation: "0",
        },
      ],
      id: "0",
      avoNonce: config.avoNonce,
      salt: ethers.utils.defaultAbiCoder.encode(["uint256"], [Date.now()]),
      source: "0x000000000000000000000000000000000000Cad0",
      metadata: "0x",
    },
    forwardParams: {
      gas: "0",
      gasPrice: "0",
      validAfter: "0",
      validUntil: "0",
      value: "0",
    },
  };

  const domain = {
    name: config.domainName,
    version: config.domainVersion,
    chainId: "634",
    verifyingContract: safeAddress,
    salt: ethers.utils.solidityKeccak256(["uint256"], [chainId]),
  };

  const signingWallets = usableWallets.slice(0, config.requiredSigners);
  const signatures = [];
  for (const wallet of signingWallets) {
    const signature = await wallet._signTypedData(domain, SIGN_TYPES, txPayload);
    signatures.push({ signature, signer: wallet.address });
    console.log("Signed by", wallet.address);
  }

  signatures.sort((a, b) => a.signer.toLowerCase().localeCompare(b.signer.toLowerCase()));

  const executor = signingWallets[0];
  const executionPayload = { ...txPayload, signatures };
  const executionSignature = await executor._signTypedData(domain, EXECUTION_TYPES, executionPayload);

  const broadcastParams = {
    signatures,
    message: txPayload,
    owner: config.owner,
    safe: safeAddress,
    index: "0",
    targetChainId: String(chainId),
    executionSignature,
    dryRun: args["dry-run"],
  };

  console.log(args["dry-run"] ? "\nDry-run broadcast..." : "\nBroadcasting...");
  const txHash = await avocadoRpc("txn_broadcast", [broadcastParams]);
  console.log("Result:", txHash);

  if (!args["dry-run"] && txHash && txHash !== "0x") {
    const receipt = await provider.waitForTransaction(txHash, 1, 180_000);
    console.log("Confirmed block:", receipt?.blockNumber, "status:", receipt?.status);

    const after = await readSafeConfig(provider, safeAddress);
    console.log("Updated signers:", after.signers);
    console.log("Updated requiredSigners:", after.requiredSigners);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
