import { z } from "zod";

/** Twilio REST API base — validated so misconfigured env cannot redirect requests. */
export const TWILIO_API_BASE_URL = "https://api.twilio.com" as const;

const e164PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{1,14}$/, "must be E.164 format (+15551234567)");

const emailSchema = z.string().trim().email();

const httpsUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => value.startsWith("https://"), "must use https");

const twilioAccountSidSchema = z
  .string()
  .trim()
  .regex(/^AC[a-f0-9]{32}$/i, "must be a Twilio Account SID (AC + 32 hex chars)");

const twilioAuthTokenSchema = z.string().trim().min(16, "must be at least 16 characters");

const smtpHostSchema = z.string().trim().min(1, "SMTP host is required");

const smtpPortSchema = z.coerce
  .number()
  .int("SMTP port must be an integer")
  .min(1)
  .max(65_535);

const smtpPasswordSchema = z.string().trim().min(1, "SMTP password is required");

const twilioChannelSchema = z.object({
  accountSid: twilioAccountSidSchema,
  authToken: twilioAuthTokenSchema,
  fromNumber: e164PhoneSchema,
  apiBaseUrl: z.literal(TWILIO_API_BASE_URL),
});

const smtpChannelSchema = z.object({
  host: smtpHostSchema,
  port: smtpPortSchema,
  user: emailSchema,
  pass: smtpPasswordSchema,
});

export type TwilioChannelConfig = z.infer<typeof twilioChannelSchema>;
export type SmtpChannelConfig = z.infer<typeof smtpChannelSchema>;

export interface NotificationSettings {
  readonly operatorSmsNumber: string;
  readonly operatorEmail: string | undefined;
  readonly sms: TwilioChannelConfig | null;
  readonly email: SmtpChannelConfig | null;
}

export class NotificationConfigError extends Error {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[]) {
    super(message);
    this.name = "NotificationConfigError";
    this.issues = issues;
  }
}

type EnvSource = NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;

function readEnv(env: EnvSource, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "value";
    return `${path}: ${issue.message}`;
  });
}

function parsePartialChannel<T>(
  label: string,
  keys: readonly string[],
  env: EnvSource,
  schema: z.ZodType<T>,
  buildInput: (env: EnvSource) => Record<string, unknown>,
): T | null {
  const present = keys.filter((key) => readEnv(env, key) !== undefined);
  if (present.length === 0) return null;

  if (present.length < keys.length) {
    const missing = keys.filter((key) => !present.includes(key));
    throw new NotificationConfigError(
      `${label} configuration is incomplete`,
      missing.map((key) => `${key}: required when any ${label} variable is set`),
    );
  }

  const parsed = schema.safeParse(buildInput(env));
  if (!parsed.success) {
    throw new NotificationConfigError(
      `${label} configuration is invalid`,
      formatZodIssues(parsed.error),
    );
  }
  return parsed.data;
}

/**
 * Parse and validate CAPTCHA operator notification settings.
 *
 * Channels are optional as a whole, but partial configuration (some vars set,
 * others missing) fails immediately so misconfiguration is caught at boot.
 */
export function parseNotificationSettings(env: EnvSource = process.env): NotificationSettings {
  const operatorSmsRaw = readEnv(env, "OPERATOR_SMS_NUMBER") ?? "+17472241814";
  const operatorSms = e164PhoneSchema.safeParse(operatorSmsRaw);
  if (!operatorSms.success) {
    throw new NotificationConfigError(
      "OPERATOR_SMS_NUMBER is invalid",
      formatZodIssues(operatorSms.error),
    );
  }

  const operatorEmailRaw = readEnv(env, "OPERATOR_EMAIL");
  let operatorEmail: string | undefined;
  if (operatorEmailRaw !== undefined) {
    const parsedEmail = emailSchema.safeParse(operatorEmailRaw);
    if (!parsedEmail.success) {
      throw new NotificationConfigError(
        "OPERATOR_EMAIL is invalid",
        formatZodIssues(parsedEmail.error),
      );
    }
    operatorEmail = parsedEmail.data;
  }

  const sms = parsePartialChannel(
    "Twilio",
    ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"],
    env,
    twilioChannelSchema,
    (source) => ({
      accountSid: readEnv(source, "TWILIO_ACCOUNT_SID"),
      authToken: readEnv(source, "TWILIO_AUTH_TOKEN"),
      fromNumber: readEnv(source, "TWILIO_FROM_NUMBER"),
      apiBaseUrl: TWILIO_API_BASE_URL,
    }),
  );

  const smtp = parsePartialChannel(
    "SMTP",
    ["SMTP_USER", "SMTP_PASS"],
    env,
    smtpChannelSchema,
    (source) => ({
      host: readEnv(source, "SMTP_HOST") ?? "smtp.gmail.com",
      port: readEnv(source, "SMTP_PORT") ?? "587",
      user: readEnv(source, "SMTP_USER"),
      pass: readEnv(source, "SMTP_PASS"),
    }),
  );

  return {
    operatorSmsNumber: operatorSms.data,
    operatorEmail,
    sms,
    email: smtp,
  };
}

/** Validate external URLs used in operator alerts before templating. */
export function parseOperatorAlertUrls(input: {
  solveUrl: string;
  pageUrl: string;
}): { solveUrl: string; pageUrl: string } {
  const schema = z.object({
    solveUrl: httpsUrlSchema,
    pageUrl: httpsUrlSchema,
  });
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new NotificationConfigError(
      "Operator alert URLs are invalid",
      formatZodIssues(parsed.error),
    );
  }
  return parsed.data;
}
