import assert from "node:assert/strict";
import test from "node:test";

import {
  decodePaymentRequiredHeader,
  parseAccepts,
  recommendSeller,
} from "./x402-rail.js";

test("decodePaymentRequiredHeader accepts raw JSON", () => {
  const payload = decodePaymentRequiredHeader(
    JSON.stringify({ accepts: [{ scheme: "exact", amount: "10000", payTo: "0xabc" }] }),
  );
  assert.ok(payload && typeof payload === "object");
});

test("decodePaymentRequiredHeader accepts base64 JSON", () => {
  const raw = Buffer.from(
    JSON.stringify({ accepts: [{ scheme: "exact", network: "eip155:8453" }] }),
    "utf8",
  ).toString("base64");
  const payload = decodePaymentRequiredHeader(raw);
  const accepts = parseAccepts(payload);
  assert.equal(accepts[0]?.network, "eip155:8453");
});

test("parseAccepts ignores junk", () => {
  assert.deepEqual(parseAccepts(null), []);
  assert.deepEqual(parseAccepts("nope"), []);
});

test("recommendSeller blocks empty 402", () => {
  assert.match(
    recommendSeller({ httpStatus: 402, paymentRequired: true, accepts: [] }),
    /empty/,
  );
});

test("recommendSeller describes exact payTo", () => {
  const text = recommendSeller({
    httpStatus: 402,
    paymentRequired: true,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "2000",
        asset: "USDC",
        payTo: "0x1111111111111111111111111111111111111111",
        maxTimeoutSeconds: 60,
      },
    ],
  });
  assert.match(text, /Pay 2000/);
  assert.match(text, /0x1111111111111111111111111111111111111111/);
});

test("recommendSeller treats 200 as free", () => {
  assert.match(
    recommendSeller({ httpStatus: 200, paymentRequired: false, accepts: [] }),
    /free/,
  );
});
