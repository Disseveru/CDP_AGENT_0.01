export interface BytecodeFlags {
  hasSelfdestruct: boolean;
  hasDelegatecall: boolean;
  hasCreate2: boolean;
  mentionsBlacklist: boolean;
  mentionsPause: boolean;
  mentionsFeeOrTax: boolean;
  isTinyStub: boolean;
  isEmpty: boolean;
}

export interface TokenBytecodeReport {
  token: string;
  bytecodeBytes: number;
  flags: BytecodeFlags;
  riskScore: number;
  verdict: "low" | "elevated" | "high" | "unknown";
  reasons: string[];
  recommendation: string;
  analyzedAt: string;
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/** Opcode bytes only — used for presence checks, not for constructing exploits. */
const OP_SELFDESTRUCT = "ff";
const OP_DELEGATECALL = "f4";
const OP_CREATE2 = "f5";

function hexBody(bytecode: string): string {
  const raw = bytecode.trim().toLowerCase();
  if (!raw.startsWith("0x")) {
    throw new Error("bytecode must be 0x-prefixed hex");
  }
  const body = raw.slice(2);
  if (body.length % 2 !== 0 || (body.length > 0 && !/^[0-9a-f]+$/.test(body))) {
    throw new Error("bytecode must be even-length hex");
  }
  if (body.length > 2 * 24_576) {
    throw new Error("bytecode exceeds 24 KiB scan limit");
  }
  return body;
}

function containsAscii(body: string, needle: string): boolean {
  const hex = Buffer.from(needle, "utf8").toString("hex");
  return body.includes(hex);
}

export function analyzeTokenBytecode(input: {
  token: string;
  bytecode: string;
}): TokenBytecodeReport {
  const token = input.token.trim();
  if (!ADDRESS_RE.test(token)) {
    throw new Error("token must be a 20-byte 0x-prefixed EVM address");
  }

  const body = hexBody(input.bytecode);
  const bytecodeBytes = body.length / 2;
  const reasons: string[] = [];

  const flags: BytecodeFlags = {
    hasSelfdestruct: body.includes(OP_SELFDESTRUCT),
    hasDelegatecall: body.includes(OP_DELEGATECALL),
    hasCreate2: body.includes(OP_CREATE2),
    mentionsBlacklist: containsAscii(body, "blacklist") || containsAscii(body, "isBlacklisted"),
    mentionsPause: containsAscii(body, "paused") || containsAscii(body, "Pausable"),
    mentionsFeeOrTax: containsAscii(body, "taxFee") || containsAscii(body, "sellFee"),
    isTinyStub: bytecodeBytes > 0 && bytecodeBytes < 80,
    isEmpty: bytecodeBytes === 0,
  };

  let riskScore = 0;
  if (flags.isEmpty) {
    riskScore += 80;
    reasons.push("No runtime bytecode — address is not a deployed contract.");
  }
  if (flags.isTinyStub) {
    riskScore += 25;
    reasons.push("Bytecode is unusually small for an ERC-20.");
  }
  if (flags.hasSelfdestruct) {
    riskScore += 35;
    reasons.push("SELFDESTRUCT opcode present.");
  }
  if (flags.hasDelegatecall) {
    riskScore += 15;
    reasons.push("DELEGATECALL present — proxy or upgrade pattern.");
  }
  if (flags.hasCreate2) {
    riskScore += 8;
    reasons.push("CREATE2 present.");
  }
  if (flags.mentionsBlacklist) {
    riskScore += 30;
    reasons.push("Blacklist-related string in bytecode.");
  }
  if (flags.mentionsPause) {
    riskScore += 12;
    reasons.push("Pause-related string in bytecode.");
  }
  if (flags.mentionsFeeOrTax) {
    riskScore += 18;
    reasons.push("Fee/tax-related string in bytecode.");
  }

  riskScore = Math.min(100, riskScore);
  const verdict: TokenBytecodeReport["verdict"] = flags.isEmpty
    ? "unknown"
    : riskScore >= 60
      ? "high"
      : riskScore >= 30
        ? "elevated"
        : "low";

  if (reasons.length === 0) {
    reasons.push("No high-risk opcode or string heuristics fired.");
  }

  const recommendation =
    verdict === "high" || verdict === "unknown"
      ? "Do not settle x402 against this token until a human reviews it."
      : verdict === "elevated"
        ? "Prefer allowlisted stables (USDC) for settlement."
        : "Heuristic scan is clean; still prefer USDC for A2A settlement.";

  return {
    token: token.toLowerCase(),
    bytecodeBytes,
    flags,
    riskScore,
    verdict,
    reasons,
    recommendation,
    analyzedAt: new Date().toISOString(),
  };
}
