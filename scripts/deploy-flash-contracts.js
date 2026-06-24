#!/usr/bin/env node
/**
 * Deploy FlashLoanReceiver + CompoundLiquidator on Base and Arbitrum.
 * Uses CDP Smart Wallet + Paymaster gas sponsorship via Nick's CREATE2 deployer.
 *
 * Usage:
 *   node scripts/deploy-flash-contracts.mjs
 *   node scripts/deploy-flash-contracts.mjs --chainId 8453
 *   node scripts/deploy-flash-contracts.mjs --dry-run
 */

const fs = require("fs");
const path = require("path");
const solc = require("solc");
const { keccak256, concatHex, padHex, toHex, encodeAbiParameters, parseAbiParameters } = require("viem");

const { CdpSmartWalletProvider } = require("@coinbase/agentkit");
const { resolveCdpCredentials } = require("../lib/cdp/credentials");
const { resolveBasePaymasterUrl } = require("../lib/cdp/paymasterGas");
const {
  createAvocadoWallet,
  ensureAvocadoGas,
  resolveAvocadoSafeAddress,
} = require("../lib/instadapp/avocadoWallet");

const CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

const FLASH_AGGREGATORS = {
  8453: "0x3813f7a28814bfaf861192d0a5a4891b15698bac",
  42161: "0x1f882522DF99820dF8e586b6df8bAae2b91a782d",
};

const CHAIN_NETWORK_IDS = {
  8453: "base-mainnet",
  42161: "arbitrum-mainnet",
};

const DEPLOYMENTS_PATH = path.join(process.cwd(), "deployments", "flash-contracts.json");

/**
 * @param {string} fileName
 * @param {string} contractName
 */
function compileContract(fileName, contractName) {
  const sourcePath = path.join(process.cwd(), "contracts", fileName);
  const source = fs.readFileSync(sourcePath, "utf8");

  const input = {
    language: "Solidity",
    sources: {
      [fileName]: { content: source },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  if (output.errors?.length) {
    const fatal = output.errors.filter((e) => e.severity === "error");
    if (fatal.length) {
      throw new Error(fatal.map((e) => e.formattedMessage).join("\n"));
    }
  }

  const artifact = output.contracts[fileName][contractName];
  if (!artifact?.evm?.bytecode?.object) {
    throw new Error(`Missing bytecode for ${contractName}`);
  }

  return {
    abi: artifact.abi,
    bytecode: `0x${artifact.evm.bytecode.object}`,
  };
}

/**
 * @param {string} bytecode
 * @param {`0x${string}`} aggregator
 * @param {`0x${string}`} owner
 */
function encodeConstructorBytecode(bytecode, aggregator, owner) {
  const args = encodeAbiParameters(parseAbiParameters(["address", "address"]), [aggregator, owner]).slice(2);
  const base = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;
  return `0x${base}${args}`;
}

/**
 * @param {string} deployer
 * @param {string} saltHex 32-byte hex
 * @param {string} bytecode
 */
function predictCreate2Address(deployer, saltHex, bytecode) {
  const bytecodeHash = keccak256(bytecode);
  const salt = padHex(saltHex, { size: 32 });
  const addressHash = keccak256(concatHex(["0xff", deployer, salt, bytecodeHash]));
  return `0x${addressHash.slice(-40)}`;
}

/**
 * @param {number} chainId
 */
async function createWalletProvider(chainId) {
  const credentials = resolveCdpCredentials();
  const networkId = CHAIN_NETWORK_IDS[chainId];
  if (!networkId) {
    throw new Error(`Unsupported chainId ${chainId}`);
  }

  const { resolveChainRpcUrl } = require("../lib/cdp/paymasterGas");
  const paymasterUrl = await resolveBasePaymasterUrl(credentials, networkId);
  const walletProvider = await CdpSmartWalletProvider.configureWithWallet({
    apiKeyId: credentials.apiKeyId,
    apiKeySecret: credentials.apiKeySecretV2,
    walletSecret: credentials.walletSecret,
    networkId,
    rpcUrl: resolveChainRpcUrl(chainId),
    paymasterUrl,
  });

  return { walletProvider, paymasterUrl, networkId };
}

/**
 * @param {import("@coinbase/agentkit").CdpSmartWalletProvider} walletProvider
 * @param {string} saltLabel
 * @param {string} initBytecode
 * @param {boolean} dryRun
 * @param {"cdp"|"avocado"} broadcaster
 * @param {number} chainId
 */
async function deployViaCreate2(walletProvider, saltLabel, initBytecode, dryRun, broadcaster, chainId) {
  const salt = keccak256(toHex(saltLabel));
  const predicted = predictCreate2Address(CREATE2_DEPLOYER, salt, initBytecode);
  const deployData = concatHex([salt, initBytecode]);

  if (dryRun) {
    return {
      predictedAddress: predicted,
      salt,
      deployData,
      dryRun: true,
      broadcaster,
    };
  }

  const publicClient = walletProvider?.getPublicClient
    ? walletProvider.getPublicClient()
    : walletProvider;

  const existing = await publicClient.getBytecode({ address: predicted });
  if (existing && existing !== "0x") {
    return {
      address: predicted,
      alreadyDeployed: true,
      salt,
      broadcaster,
    };
  }

  if (broadcaster === "avocado") {
    const safeAddress = await resolveAvocadoSafeAddress();
    const { safe } = createAvocadoWallet(undefined, safeAddress);
    await ensureAvocadoGas(safe, safeAddress);
    const response = await safe.sendTransactions(
      [
        {
          to: CREATE2_DEPLOYER,
          data: deployData,
          value: 0,
        },
      ],
      chainId,
      { safeAddress },
    );

    const deployedCode = await publicClient.getBytecode({ address: predicted });
    return {
      address: predicted,
      txHash: response.hash,
      deployed: Boolean(deployedCode && deployedCode !== "0x"),
      salt,
      broadcaster,
      safeAddress,
    };
  }

  const userOpHash = await walletProvider.sendTransaction({
    to: CREATE2_DEPLOYER,
    data: deployData,
    value: 0n,
  });

  const receipt = await walletProvider.waitForTransactionReceipt(userOpHash);
  const deployedCode = await publicClient.getBytecode({ address: predicted });

  return {
    address: predicted,
    userOpHash,
    transactionHash: receipt.transactionHash,
    status: receipt.status,
    deployed: Boolean(deployedCode && deployedCode !== "0x"),
    salt,
    smartWallet: walletProvider.getAddress(),
    broadcaster: "cdp",
  };
}

/**
 * @param {object} update
 */
function saveDeployments(update) {
  const dir = path.dirname(DEPLOYMENTS_PATH);
  fs.mkdirSync(dir, { recursive: true });

  let existing = {};
  if (fs.existsSync(DEPLOYMENTS_PATH)) {
    existing = JSON.parse(fs.readFileSync(DEPLOYMENTS_PATH, "utf8"));
  }

  const merged = { ...existing, ...update, updatedAt: new Date().toISOString() };
  fs.writeFileSync(DEPLOYMENTS_PATH, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

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

async function deployChain(chainId, dryRun, broadcaster) {
  const aggregator = FLASH_AGGREGATORS[chainId];
  if (!aggregator) {
    throw new Error(`No flash aggregator configured for chain ${chainId}`);
  }

  const receiverArtifact = compileContract("FlashLoanReceiver.sol", "FlashLoanReceiver");
  const liquidatorArtifact = compileContract("CompoundLiquidator.sol", "CompoundLiquidator");

  const { Wallet } = require("ethers");
  const { resolveSigningKey } = require("../lib/instadapp/keys");
  const owner =
    process.env.FLASH_CONTRACT_OWNER || new Wallet(resolveSigningKey()).address;

  const receiverInit = encodeConstructorBytecode(receiverArtifact.bytecode, aggregator, owner);
  const liquidatorInit = encodeConstructorBytecode(liquidatorArtifact.bytecode, aggregator, owner);

  let walletProvider;
  let paymasterUrl;
  let networkId;

  if (broadcaster === "cdp") {
    ({ walletProvider, paymasterUrl, networkId } = await createWalletProvider(chainId));
  } else {
    const { createPublicClient, http } = require("viem");
    const { base, arbitrum } = require("viem/chains");
    const { resolveChainRpcUrl } = require("../lib/cdp/paymasterGas");
    const chain = chainId === 8453 ? base : arbitrum;
    walletProvider = createPublicClient({
      chain,
      transport: http(resolveChainRpcUrl(chainId)),
    });
    networkId = CHAIN_NETWORK_IDS[chainId];
    paymasterUrl = "avocado-usdc-gas-tank";
  }

  const receiverResult = await deployViaCreate2(
    walletProvider,
    `FlashLoanReceiver-${chainId}-v4`,
    receiverInit,
    dryRun,
    broadcaster,
    chainId,
  );

  const liquidatorResult = await deployViaCreate2(
    walletProvider,
    `CompoundLiquidator-${chainId}-v3`,
    liquidatorInit,
    dryRun,
    broadcaster,
    chainId,
  );

  const chainKey = String(chainId);
  const smartWalletRef =
    broadcaster === "cdp" && typeof walletProvider.getAddress === "function"
      ? walletProvider.getAddress()
      : receiverResult.safeAddress;

  const record = {
    [chainKey]: {
      networkId,
      aggregator,
      paymasterUrl,
      deployer: CREATE2_DEPLOYER,
      smartWallet: smartWalletRef,
      broadcaster,
      owner,
      flashLoanReceiver: {
        address: receiverResult.address || receiverResult.predictedAddress,
        abi: receiverArtifact.abi,
        ...receiverResult,
      },
      compoundLiquidator: {
        address: liquidatorResult.address || liquidatorResult.predictedAddress,
        abi: liquidatorArtifact.abi,
        ...liquidatorResult,
      },
    },
  };

  if (!dryRun) {
    saveDeployments(record);
  }

  return record;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const dryRun = Boolean(flags["dry-run"]);
  const broadcaster = flags.broadcaster === "cdp" ? "cdp" : "avocado";
  const chains = flags.chainId ? [Number(flags.chainId)] : [8453, 42161];

  console.log(
    `Deploying flash contracts (${dryRun ? "dry-run" : "live"}, broadcaster=${broadcaster}) on chains: ${chains.join(", ")}`,
  );

  const results = {};
  for (const chainId of chains) {
    console.log(`\n=== chain ${chainId} ===`);
    try {
      results[chainId] = await deployChain(chainId, dryRun, broadcaster);
      console.log(JSON.stringify(results[chainId], null, 2));
    } catch (error) {
      results[chainId] = {
        error: error instanceof Error ? error.message : String(error),
      };
      console.error(`chain ${chainId} failed:`, error);
    }
  }

  if (!dryRun) {
    console.log(`\nSaved deployment manifest: ${DEPLOYMENTS_PATH}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
