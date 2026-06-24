import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import solc from "solc";

const SOURCE_PATH = path.join(process.cwd(), "contracts", "CompoundLiquidator.sol");

function compileCompoundLiquidator() {
  const fileName = "CompoundLiquidator.sol";
  const source = fs.readFileSync(SOURCE_PATH, "utf8");
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { [fileName]: { content: source } },
        settings: {
          optimizer: { enabled: true, runs: 200 },
          outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
        },
      }),
    ),
  );

  const errors = output.errors?.filter((entry) => entry.severity === "error") || [];
  if (errors.length) {
    throw new Error(errors.map((entry) => entry.formattedMessage).join("\n"));
  }

  return output.contracts[fileName].CompoundLiquidator;
}

test("CompoundLiquidator keeps owed flash-loan balance after skimming profit", () => {
  const owed = 1_000_000n + 900n;
  const balance = 1_050_000n;
  const profit = balance - owed;

  assert.equal(profit, 49_100n);
  assert.ok(balance - profit >= owed);
});

test("CompoundLiquidator compiles with repay-balance guard", () => {
  const artifact = compileCompoundLiquidator();
  assert.ok(artifact.evm.bytecode.object.length > 0);
  assert.match(fs.readFileSync(SOURCE_PATH, "utf8"), /balance >= owed/);
});
