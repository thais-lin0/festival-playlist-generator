// CloudWatch Embedded Metric Format: a specially shaped log line becomes a metric.
// Written straight to stdout: with the Lambda JSON log format, console.log wraps the
// line inside "message" and CloudWatch no longer recognizes it as EMF.
export const METRICS_NAMESPACE = "FestivalPlaylist";

type Unit = "Count" | "Milliseconds";

export function metric(name: string, value: number, unit: Unit = "Count", dimensions: Record<string, string> = {}) {
  const stage = process.env.STAGE ?? "dev";
  process.stdout.write(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          { Namespace: METRICS_NAMESPACE, Dimensions: [["Stage", ...Object.keys(dimensions)]], Metrics: [{ Name: name, Unit: unit }] },
        ],
      },
      Stage: stage,
      ...dimensions,
      [name]: value,
    }) + "\n",
  );
}
