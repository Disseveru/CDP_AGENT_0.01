export type CaptchaType = "recaptcha" | "hcaptcha" | "turnstile";

export type CaptchaTaskStatus = "pending" | "completed" | "expired";

export interface CaptchaTask {
  task_id: string;
  sitekey: string;
  pageurl: string;
  captcha_type: CaptchaType;
  status: CaptchaTaskStatus;
  /** Agent-only secret for polling /api/v1/captcha/status. */
  poll_token: string;
  /** Operator-only secret embedded in the SMS solve link. */
  solve_token: string;
  solution_token?: string;
  created_at: string;
  completed_at?: string;
  payment_tx?: string;
}

export interface CaptchaSubmitInput {
  sitekey: string;
  pageurl: string;
  captcha_type: CaptchaType;
}

export interface CaptchaSubmitResult {
  task_id: string;
  status: "pending";
  /** Operator solve page URL (includes solve_token); not required for agent polling. */
  solve_url: string;
  /** Required to poll GET /api/v1/captcha/status for the solution token. */
  poll_token: string;
}

export interface CaptchaStatusResult {
  task_id: string;
  status: CaptchaTaskStatus;
  solution_token?: string;
  created_at: string;
  completed_at?: string;
}

export interface SanitizedOperatorAlert {
  readonly taskId: string;
  readonly solveUrl: string;
  readonly captchaType: CaptchaType;
  readonly pageUrl: string;
}
