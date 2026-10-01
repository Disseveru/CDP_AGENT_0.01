/**
 * In-process Prometheus-style metrics collector for the gas-oracle MCP server.
 *
 * Tracks CAPTCHA task lifecycle counters, payment volume, API request
 * counts/latency, and process uptime. Exposed via GET /metrics in text
 * format so it can be scraped directly by Prometheus.
 */

const MAX_SAMPLES = 100;

class RollingAverage {
  private samples: number[] = [];

  record(value: number): void {
    this.samples.push(value);
    if (this.samples.length > MAX_SAMPLES) {
      this.samples.shift();
    }
  }

  average(): number {
    if (this.samples.length === 0) return 0;
    const sum = this.samples.reduce((acc, v) => acc + v, 0);
    return sum / this.samples.length;
  }
}

class MetricsCollector {
  private readonly startedAt = Date.now();

  // Counters
  private captchaTasksCreated = 0;
  private captchaTasksSolved = 0;
  private captchaTasksFailed = 0;
  private paymentsProcessed = 0;
  private requestsTotal = 0;
  private requestsSuccess = 0;
  private requestsError = 0;

  // Gauges / rolling state
  private captchaTasksPending = 0;
  private totalUsdcCollected = 0;
  private readonly captchaSolveTimes = new RollingAverage();
  private readonly requestLatencies = new RollingAverage();

  recordCaptchaTaskCreated(): void {
    this.captchaTasksCreated += 1;
    this.captchaTasksPending += 1;
  }

  recordCaptchaTaskSolved(durationMs: number): void {
    this.captchaTasksSolved += 1;
    this.captchaTasksPending = Math.max(0, this.captchaTasksPending - 1);
    this.captchaSolveTimes.record(durationMs);
  }

  recordCaptchaTaskFailed(): void {
    this.captchaTasksFailed += 1;
    this.captchaTasksPending = Math.max(0, this.captchaTasksPending - 1);
  }

  recordRequest(latencyMs: number, success: boolean): void {
    this.requestsTotal += 1;
    if (success) {
      this.requestsSuccess += 1;
    } else {
      this.requestsError += 1;
    }
    this.requestLatencies.record(latencyMs);
  }

  recordPayment(amountUsdc: number): void {
    this.paymentsProcessed += 1;
    this.totalUsdcCollected += amountUsdc;
  }

  private uptimeSeconds(): number {
    return (Date.now() - this.startedAt) / 1000;
  }

  export(): string {
    const lines: string[] = [];

    const counter = (name: string, help: string, value: number) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name} ${value}`);
    };

    const gauge = (name: string, help: string, value: number) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${value}`);
    };

    counter(
      "gas_oracle_captcha_tasks_created_total",
      "Total number of CAPTCHA bypass tasks created",
      this.captchaTasksCreated,
    );
    counter(
      "gas_oracle_captcha_tasks_solved_total",
      "Total number of CAPTCHA bypass tasks solved",
      this.captchaTasksSolved,
    );
    counter(
      "gas_oracle_captcha_tasks_failed_total",
      "Total number of CAPTCHA bypass tasks that failed",
      this.captchaTasksFailed,
    );
    counter(
      "gas_oracle_payments_processed_total",
      "Total number of x402 payments processed",
      this.paymentsProcessed,
    );
    counter(
      "gas_oracle_requests_total",
      "Total number of HTTP/MCP requests handled",
      this.requestsTotal,
    );
    counter(
      "gas_oracle_requests_success_total",
      "Total number of successful HTTP/MCP requests",
      this.requestsSuccess,
    );
    counter(
      "gas_oracle_requests_error_total",
      "Total number of failed HTTP/MCP requests",
      this.requestsError,
    );

    gauge(
      "gas_oracle_captcha_tasks_pending",
      "Number of CAPTCHA bypass tasks currently pending",
      this.captchaTasksPending,
    );
    gauge(
      "gas_oracle_captcha_average_solve_time_ms",
      "Rolling average CAPTCHA solve time in milliseconds",
      this.captchaSolveTimes.average(),
    );
    gauge(
      "gas_oracle_requests_average_latency_ms",
      "Rolling average request latency in milliseconds",
      this.requestLatencies.average(),
    );
    gauge(
      "gas_oracle_total_usdc_collected",
      "Total USDC collected across all payments",
      this.totalUsdcCollected,
    );
    gauge(
      "gas_oracle_uptime_seconds",
      "Number of seconds the process has been running",
      this.uptimeSeconds(),
    );

    return lines.join("\n") + "\n";
  }
}

export const metricsCollector = new MetricsCollector();
