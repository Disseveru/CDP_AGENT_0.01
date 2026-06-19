/**
 * Instadapp flashloan spell conductor for CDP AgentKit.
 *
 * Registers `execute_flashloan_spell_conductor` via customActionProvider.
 * Targets Base mainnet (chain id 8453) through dsa-connect.
 */

const { z } = require("zod");
const { customActionProvider } = require("@coinbase/agentkit");
const DSA = require("dsa-connect");
const Web3 = require("web3");

const instadapp = require("../../lib/instadapp");
const { buildSpellInstance } = require("../../lib/instadapp/spells");
const baseChain = require("../../lib/base/blockchain-data");

const BASE_MAINNET_CHAIN_ID = baseChain.BASE_MAINNET.chainId;
const DEFAULT_SWAP_CONNECTOR = "UNISWAP-V3-SWAP-A";
const FLASH_PAYBACK_FEE_BPS = 9;

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const HUMAN_AMOUNT_REGEX = /^\d+(\.\d+)?$/;

const executeFlashloanSchema = z.object({
  borrowToken: z
    .string()
    .regex(ADDRESS_REGEX, "borrowToken must be a checksummed or lowercase 0x-prefixed address"),
  borrowAmount: z
    .string()
    .regex(HUMAN_AMOUNT_REGEX, "borrowAmount must be a positive human-readable decimal string"),
  targetRoute: z.number().int().nonnegative().default(1),
  targetDexAddress: z
    .string()
    .regex(ADDRESS_REGEX, "targetDexAddress must be a 0x-prefixed pool address"),
  minReceiveAmount: z
    .string()
    .regex(HUMAN_AMOUNT_REGEX, "minReceiveAmount must be a positive human-readable decimal string"),
});

/**
 * @param {import("@coinbase/agentkit").EvmWalletProvider} walletProvider
 */
function resolveAuthorityAddress(walletProvider) {
  if (walletProvider.ownerAccount?.address) {
    return walletProvider.ownerAccount.address;
  }

  return walletProvider.getAddress();
}

/**
 * @param {import("@coinbase/agentkit").EvmWalletProvider} walletProvider
 * @param {number} chainId
 */
function createWeb3FromWalletProvider(walletProvider) {
  return baseChain.createBaseWeb3(walletProvider);
}

/**
 * @param {import("@coinbase/agentkit").EvmWalletProvider} walletProvider
 */
function resolvePublicClient(walletProvider) {
  if (typeof walletProvider.getPublicClient === "function") {
    return walletProvider.getPublicClient();
  }

  return undefined;
}

/**
 * @param {string} message
 */
function normalizeAddress(message) {
  return message.toLowerCase();
}

const {
  calculateUnitAmt,
  readTokenDecimalsWithClient,
  readUniswapV3Pool,
  toTokenWei,
} = baseChain;

/**
 * @param {string} borrowAmountWei
 * @param {number} [feeBps]
 */
function computeFlashPaybackAmount(borrowAmountWei, feeBps = FLASH_PAYBACK_FEE_BPS) {
  const borrow = BigInt(borrowAmountWei);
  return ((borrow * BigInt(10_000 + feeBps)) / 10_000n).toString();
}

/**
 * @param {unknown} error
 */
function extractRevertReason(error) {
  if (!error) {
    return "Unknown revert reason.";
  }

  if (typeof error === "string") {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);

  const patterns = [
    /reason="([^"]+)"/i,
    /reverted with reason string '([^']+)'/i,
    /execution reverted: ([^"\n]+)/i,
    /VM Exception while processing transaction: revert ([^"\n]+)/i,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return message;
}

/**
 * @param {import("dsa-connect").DSA} dsa
 * @param {{
 *   borrowToken: string,
 *   borrowAmountWei: string,
 *   targetRoute: number,
 *   buyToken: string,
 *   poolFee: number,
 *   unitAmt: string,
 *   paybackAmountWei: string,
 *   swapConnector?: string,
 * }} params
 */
function buildFlashloanSpells(dsa, params) {
  const swapConnector = params.swapConnector || DEFAULT_SWAP_CONNECTOR;

  const swapSpell = {
    connector: swapConnector,
    method: "sell",
    args: [
      params.buyToken,
      params.borrowToken,
      params.poolFee,
      params.unitAmt,
      params.borrowAmountWei,
      0,
      0,
    ],
  };

  const paybackSpell = {
    connector: "INSTAPOOL-C",
    method: "flashPayback",
    args: [params.borrowToken, params.paybackAmountWei, 0, 0],
  };

  const innerSpells = dsa.Spell();
  innerSpells.add(swapSpell);
  innerSpells.add(paybackSpell);

  const encodedInner = dsa.instapool_v2.encodeFlashCastData(innerSpells);

  const borrowSpell = {
    connector: "INSTAPOOL-C",
    method: "flashBorrowAndCast",
    args: [params.borrowToken, params.borrowAmountWei, params.targetRoute, encodedInner, "0x"],
  };

  return {
    logicalSpells: [borrowSpell, swapSpell, paybackSpell],
    castSpells: [borrowSpell],
  };
}

/**
 * @param {import("@coinbase/agentkit").EvmWalletProvider} walletProvider
 * @param {z.infer<typeof executeFlashloanSchema>} args
 */
async function executeFlashloanSpellConductor(walletProvider, args) {
  const network = walletProvider.getNetwork();
  const chainId = network.chainId ?? Number(process.env.DSA_CHAIN_ID || BASE_MAINNET_CHAIN_ID);

  if (chainId !== BASE_MAINNET_CHAIN_ID) {
    return [
      "Flashloan conductor requires Base mainnet (chain id 8453).",
      `Active wallet network is ${network.networkId || "unknown"} (chain id ${chainId}).`,
      "Set NETWORK_ID=base-mainnet and DSA_CHAIN_ID=8453 before invoking this tool.",
    ].join(" ");
  }

  const borrowToken = Web3.utils.toChecksumAddress(args.borrowToken);
  const targetDexAddress = Web3.utils.toChecksumAddress(args.targetDexAddress);
  const agentAddress = Web3.utils.toChecksumAddress(resolveAuthorityAddress(walletProvider));

  const publicClient = resolvePublicClient(walletProvider);
  const web3 = createWeb3FromWalletProvider(walletProvider);
  const privateKey = instadapp.resolveSigningKey();
  const signerAddress = web3.eth.accounts.privateKeyToAccount(privateKey).address;

  if (normalizeAddress(signerAddress) !== normalizeAddress(agentAddress)) {
    return [
      "The DSA signing key does not match the active CDP wallet authority address.",
      `Signer: ${signerAddress}`,
      `Wallet authority: ${agentAddress}`,
      "Use the owner EOA private key (DSA_PRIVATE_KEY / MNEMONIC_PHRASE / wallet_data.txt seed) that controls this CDP wallet.",
    ].join(" ");
  }

  const dsa = new DSA({ web3, mode: "node", privateKey }, chainId);

  let dsaEnsured;
  const existingAccounts = await instadapp.listDsaAccounts(dsa, agentAddress);

  if (existingAccounts.length === 0) {
    const buildTxHash = await instadapp.buildDsaAccount(dsa, web3);
    const refreshedAccounts = await instadapp.listDsaAccounts(dsa, agentAddress);

    if (refreshedAccounts.length === 0) {
      return `DSA build transaction ${buildTxHash} was broadcast, but no DSA account is visible yet for ${agentAddress}. Wait for confirmation and retry.`;
    }

    const instance = await dsa.setInstance(refreshedAccounts[0].id);
    instadapp.saveDsaChainState(
      chainId,
      {
        dsaId: instance.id,
        dsaAddress: instance.address,
        lastBuildTx: buildTxHash,
      },
      agentAddress,
    );

    dsaEnsured = {
      instance,
      accounts: refreshedAccounts,
      created: true,
      buildTxHash,
    };
  } else {
    dsaEnsured = await instadapp.ensureDsaInstance(dsa, web3, agentAddress, {
      autoBuild: false,
      chainId,
    });
  }

  const pool = await readUniswapV3Pool(web3, targetDexAddress, publicClient);
  if (pool.liquidity === "0") {
    return [
      `Uniswap V3 pool ${targetDexAddress} reports zero liquidity on Base mainnet.`,
      "Choose a pool with active liquidity or verify the pool address via Base block explorer.",
      baseChain.BASE_MAINNET.blockExplorer,
    ].join(" ");
  }

  const borrowTokenNormalized = normalizeAddress(borrowToken);

  let buyToken;
  if (borrowTokenNormalized === normalizeAddress(pool.token0)) {
    buyToken = pool.token1;
  } else if (borrowTokenNormalized === normalizeAddress(pool.token1)) {
    buyToken = pool.token0;
  } else {
    return [
      `borrowToken ${borrowToken} is not part of Uniswap V3 pool ${targetDexAddress}.`,
      `Pool tokens: token0=${pool.token0}, token1=${pool.token1}.`,
    ].join(" ");
  }

  const [borrowDecimals, buyDecimals] = await Promise.all([
    readTokenDecimalsWithClient(web3, borrowToken, publicClient),
    readTokenDecimalsWithClient(web3, buyToken, publicClient),
  ]);

  const borrowAmountWei = toTokenWei(args.borrowAmount, borrowDecimals);
  const minReceiveWei = toTokenWei(args.minReceiveAmount, buyDecimals);
  const unitAmt = calculateUnitAmt(minReceiveWei, borrowAmountWei, buyDecimals, borrowDecimals);
  const paybackAmountWei = computeFlashPaybackAmount(borrowAmountWei);

  const spellBundle = buildFlashloanSpells(dsa, {
    borrowToken,
    borrowAmountWei,
    targetRoute: args.targetRoute,
    buyToken,
    poolFee: pool.fee,
    unitAmt,
    paybackAmountWei,
  });

  const spellInstance = buildSpellInstance(dsa, spellBundle.castSpells);
  const gasPrice =
    process.env.DSA_GAS_PRICE_GWEI || (await web3.eth.getGasPrice());

  try {
    await spellInstance.encodeSpells();
  } catch (encodeError) {
    return [
      "Flashloan spell encoding failed before simulation.",
      `Reason: ${extractRevertReason(encodeError)}`,
      "No transaction was sent; verify connector names, token addresses, and pool metadata.",
    ].join(" ");
  }

  let estimatedGas;
  try {
    estimatedGas = await spellInstance.estimateCastGas({ gasPrice });
  } catch (simulationError) {
    return [
      "Flashloan simulation indicates the transaction would revert; broadcast skipped to save gas.",
      `Revert reason: ${extractRevertReason(simulationError)}`,
      `borrowToken=${borrowToken}, buyToken=${buyToken}, pool=${targetDexAddress}, route=${args.targetRoute}.`,
      "Try increasing minReceiveAmount tolerance, verify pool liquidity, or choose a different targetDexAddress.",
    ].join(" ");
  }

  try {
    const txHash = await spellInstance.cast({ gasPrice });

    return JSON.stringify(
      {
        status: "success",
        message: "Flashloan spell conductor executed atomically on Base mainnet.",
        txHash,
        agentAddress,
        dsa: dsaEnsured.instance,
        createdDsa: Boolean(dsaEnsured.created),
        buildTxHash: dsaEnsured.buildTxHash,
        borrowToken,
        borrowAmount: args.borrowAmount,
        borrowAmountWei,
        buyToken,
        targetDexAddress,
        poolFee: pool.fee,
        minReceiveAmount: args.minReceiveAmount,
        minReceiveWei,
        unitAmt,
        paybackAmountWei,
        targetRoute: args.targetRoute,
        estimatedGas: String(estimatedGas),
        logicalSpells: spellBundle.logicalSpells,
        dataSources: {
          baseDocsIndex: baseChain.BASE_MAINNET.docsIndex,
          rpcUrl: baseChain.resolveBaseMainnetRpcUrl(walletProvider),
          readMethod: publicClient ? "viem eth_call via getPublicClient()" : "web3 eth_call",
        },
      },
      null,
      2,
    );
  } catch (broadcastError) {
    return [
      "Flashloan passed simulation but the on-chain cast failed.",
      `Reason: ${extractRevertReason(broadcastError)}`,
      "Check signer gas balance and nonce, then retry.",
    ].join(" ");
  }
}

const instadappFlashloanActionProvider = customActionProvider({
  name: "execute_flashloan_spell_conductor",
  description: [
    "Execute an atomic Instadapp DSA flashloan spell conductor on Base mainnet (8453).",
    "Provisions a DSA for the CDP wallet authority if missing, borrows borrowToken via INSTAPOOL-C flashBorrowAndCast,",
    "swaps through the Uniswap V3 pool at targetDexAddress with minReceiveAmount slippage protection,",
    "and repays the flashloan via flashPayback in the same transaction.",
    "Requires DSA signing credentials (DSA_PRIVATE_KEY, MNEMONIC_PHRASE, or wallet_data.txt seed) matching the CDP wallet owner.",
  ].join(" "),
  schema: executeFlashloanSchema,
  invoke: executeFlashloanSpellConductor,
});

module.exports = {
  instadappFlashloanActionProvider,
  executeFlashloanSchema,
  executeFlashloanSpellConductor,
  buildFlashloanSpells,
  calculateUnitAmt,
  computeFlashPaybackAmount,
  createWeb3FromWalletProvider,
  resolveAuthorityAddress,
  resolvePublicClient,
  toTokenWei,
};
