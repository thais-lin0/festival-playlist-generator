import type { APIGatewayProxyResultV2 } from "aws-lambda";

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };

export function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers, body: JSON.stringify(body) };
}

export function error(statusCode: number, message: string): APIGatewayProxyResultV2 {
  return json(statusCode, { error: message });
}

export function redirect(location: string): APIGatewayProxyResultV2 {
  return { statusCode: 302, headers: { Location: location, "Cache-Control": "no-store" }, body: "" };
}

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}
