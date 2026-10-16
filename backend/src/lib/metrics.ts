// CloudWatch Embedded Metric Format: a specially shaped log line becomes a metric.
export const METRICS_NAMESPACE = "FestivalPlaylist";

type Unit = "Count" | "Milliseconds";

export function metric(name: string, value: number, unit: Unit = "Count", dimensions: Record<string, string> = {}) {
  const stage = process.env.STAGE ?? "dev";
  console.log(
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
    }),
  );
}
