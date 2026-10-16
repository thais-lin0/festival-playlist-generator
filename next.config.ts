import type { NextConfig } from "next";

// Static export: the build in out/ is uploaded to S3 and served by CloudFront.
// Runtime settings (API URL, Cognito) come from /config.json, written by the CDK stack.
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
