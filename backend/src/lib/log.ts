// One JSON object per line so CloudWatch Logs Insights can query fields.
// Never pass tokens, secrets or image bytes in `data`.
type Level = "info" | "warn" | "error";

function write(level: Level, message: string, data?: Record<string, unknown>) {
  const line = JSON.stringify({ level, message, ...data, time: new Date().toISOString() });
  (level === "error" ? console.error : console.log)(line);
}

export const log = {
  info: (message: string, data?: Record<string, unknown>) => write("info", message, data),
  warn: (message: string, data?: Record<string, unknown>) => write("warn", message, data),
  error: (message: string, error: unknown, data?: Record<string, unknown>) =>
    write("error", message, {
      ...data,
      error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
    }),
};
