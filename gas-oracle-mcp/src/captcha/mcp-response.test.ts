import assert from "node:assert/strict";
import test from "node:test";

import { parseCaptchaTaskResponse } from "./mcp-response.js";

test("parseCaptchaTaskResponse accepts pending task payloads", () => {
  const parsed = parseCaptchaTaskResponse({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          task_id: "550e8400-e29b-41d4-a716-446655440000",
          status: "pending",
          poll_token: "poll-token",
          solve_url: "https://example.com/solve/550e8400-e29b-41d4-a716-446655440000",
        }),
      },
    ],
  });

  assert.deepEqual(parsed, {
    task_id: "550e8400-e29b-41d4-a716-446655440000",
    poll_token: "poll-token",
    solve_url: "https://example.com/solve/550e8400-e29b-41d4-a716-446655440000",
  });
});

test("parseCaptchaTaskResponse accepts completed task payloads for settlement rollback", () => {
  const parsed = parseCaptchaTaskResponse({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          task_id: "550e8400-e29b-41d4-a716-446655440000",
          status: "completed",
          solution_token: "token",
          poll_token: "poll-token",
          solve_url: "https://example.com/solve/550e8400-e29b-41d4-a716-446655440000",
          completed_at: "2026-06-29T00:00:00.000Z",
        }),
      },
    ],
  });

  assert.equal(parsed?.task_id, "550e8400-e29b-41d4-a716-446655440000");
});

test("parseCaptchaTaskResponse rejects payment error payloads", () => {
  const parsed = parseCaptchaTaskResponse({
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: "Payment settlement failed" }),
      },
    ],
  });

  assert.equal(parsed, null);
});
