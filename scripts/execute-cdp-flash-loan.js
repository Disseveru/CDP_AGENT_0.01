#!/usr/bin/env node
/**
 * Deploy FlashLoanReceiver owned by the active CDP smart wallet, then execute
 * a Base mainnet flash loan with paymaster-sponsored gas.
 */

const fs = require("fs");
const path = require("path");
const solc = require("solc");
const { ethers } = require("ethers");
const { keccak256, concatHex, padHex, toHex, encodeAbiParameters, parseAbiParameters } = require("viem");
const { CdpSmartWalletProvider } = require("@coinbase/agentkit");

const { resolveCdpCredentials } = require("../lib/cdp/credentials");
const { createPaymasterWalletProvider, resolveChainRpcUrl } = require("../lib/cdp/paymasterGas");
const { getTokenAddress } = require("../lib/instadapp/tokens");

const CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const AGGREGATOR = "0x3813f7a28814bfaf861192d0a5a4891b15698bac";
const CHAIN_ID = 8453;
const FLASH_ROUTE = 5;
const FLASH_AMOUNT_USDC = process.env.FLASH_AMOUNT_USDC || "5000";

function compileReceiver() {
  const source = fs.readFileSync(path.join(process.cwd(), "contracts", "FlashLoanReceiver.sol"), "utf8");
  const input = {
    language: "Solidity",
    sources: { "FlashLoanReceiver.sol": { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const artifact = output.contracts["FlashLoanReceiver.sol"].FlashLoanReceiver;
  return {
    abi: artifact.abi,
    bytecode: `0x${artifact.evm.bytecode.object}`,
  };
}

function predictCreate2Address(deployer, saltHex, bytecode) {
  const bytecodeHash = keccak256(bytecode);
  const salt = padHex(saltHex, { size: 32 });
  const addressHash = keccak256(concatHex(["0xff", deployer, salt, bytecodeHash]));
  return `0x${addressHash.slice(-40)}`;
}

async function main() {
  const { walletProvider } = await createPaymasterWalletProvider(CHAIN_ID);
  const owner = walletProvider.getAddress();
  const { abi, bytecode } = compileReceiver();

  const args = encodeAbiParameters(parseAbiParameters(["address", "address"]), [
    AGGREGATOR,
    owner,
  ]).slice(2);
  const initBytecode = `${bytecode}${args}`;
  const salt = keccak256(toHex(`FlashLoanReceiver-${CHAIN_ID}-cdp-exec-${Date.now()}`));
  const predicted = predictCreate2Address(CREATE2_DEPLOYER, salt, initBytecode);
  const deployData = concatHex([salt, initBytecode]);

  console.log("CDP smart wallet (owner):", owner);
  console.log("Predicted receiver:", predicted);

  const publicClient = walletProvider.getPublicClient();
  const existing = await publicClient.getBytecode({ address: predicted });
  if (!existing || existing === "0x") {
    const deployOp = await walletProvider.sendTransaction({
      to: CREATE2_DEPLOYER,
      data: deployData,
      value: 0n,
    });
    const deployRcpt = await walletProvider.waitForTransactionReceipt(deployOp);
    console.log("Deploy tx:", deployRcpt.transactionHash, "status:", deployRcpt.status);
  } else {
    console.log("Receiver already deployed");
  }

  const usdc = getTokenAddress(CHAIN_ID, "USDC");
  const amount = ethers.utils.parseUnits(FLASH_AMOUNT_USDC, 6);
  const callbackData = ethers.utils.defaultAbiCoder.encode(
    ["address", "bytes"],
    ["0x0000000000000000000000000000000000000000", "0x"],
  );
  const iface = new ethers.utils.Interface([
    "function requestFlashLoan(address[] tokens, uint256[] amounts, uint256 route, bytes data)",
  ]);
  const data = iface.encodeFunctionData("requestFlashLoan", [
    [usdc],
    [amount],
    FLASH_ROUTE,
    callbackData,
  ]);

  const flashOp = await walletProvider.sendTransaction({
    to: predicted,
    data,
    value: 0n,
  });
  const flashRcpt = await walletProvider.waitForTransactionReceipt(flashOp);
  console.log(
    JSON.stringify(
      {
        success: flashRcpt.status === "success",
        receiver: predicted,
        owner,
        flashAmountUsdc: FLASH_AMOUNT_USDC,
        route: FLASH_ROUTE,
        userOpHash: flashOp,
        transactionHash: flashRcpt.transactionHash,
        basescan: `https://basescan.org/tx/${flashRcpt.transactionHash}`,
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
