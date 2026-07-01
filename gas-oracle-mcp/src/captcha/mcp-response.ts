/** Parse MCP tool JSON text for CAPTCHA rollback (pending or completed payloads). */
export function parseCaptchaTaskResponse(
  result: { content?: { type: string; text?: string }[] },
): { task_id: string; poll_token: string; solve_url: string } | null {
  const text = result.content?.[0]?.text;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as {
      task_id?: string;
      poll_token?: string;
      solve_url?: string;
    };
    if (parsed.task_id && parsed.poll_token && parsed.solve_url) {
      return {
        task_id: parsed.task_id,
        poll_token: parsed.poll_token,
        solve_url: parsed.solve_url,
      };
    }
  } catch {
    return null;
  }
  return null;
}
