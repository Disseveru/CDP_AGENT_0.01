export type CaptchaType = "recaptcha" | "hcaptcha" | "turnstile";

export type CaptchaTaskStatus = "pending" | "completed" | "expired";

export interface CaptchaTask {
  task_id: string;
  sitekey: string;
  pageurl: string;
  captcha_type: CaptchaType;
  status: CaptchaTaskStatus;
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
  solve_url: string;
}

export interface CaptchaStatusResult {
  task_id: string;
  status: CaptchaTaskStatus;
  solution_token?: string;
  created_at: string;
  completed_at?: string;
}
