import * as cdk from "aws-cdk-lib";
import { FestivalPlaylistStack } from "./stack";

const app = new cdk.App();
const ctx = (key: string, fallback: string): string => app.node.tryGetContext(key) || fallback;

const stage = ctx("stage", "dev");
// Personal settings (owner, alarmEmail) live in backend/cdk.context.json, which is git-ignored.
const owner = ctx("owner", "unknown");
// Every resource name starts with this, so it's easy to spot in the console.
const prefix = `festival-playlist-${stage}`;

new FestivalPlaylistStack(app, `FestivalPlaylist-${stage}`, {
  stackName: `festival-playlist-${stage}`,
  description: `Festival Playlist Generator (${stage}): line-up poster -> Spotify playlist`,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: "us-east-1" },
  stage,
  prefix,
  alarmEmail: ctx("alarmEmail", ""),
  bedrockProvider: ctx("bedrockProvider", "nova") === "claude" ? "claude" : "nova",
  bedrockModelId: ctx("bedrockModelId", "us.amazon.nova-pro-v1:0"),
  bedrockApi: ctx("bedrockApi", "mantle") === "invoke" ? "invoke" : "mantle",
});

// Applied to every taggable resource in the stack.
const tags: Record<string, string> = {
  Project: "festival-playlist-generator",
  Application: "FestivalPlaylist",
  Environment: stage,
  Owner: owner,
  ManagedBy: "aws-cdk",
  CostCenter: "festival-playlist",
};
for (const [key, value] of Object.entries(tags)) cdk.Tags.of(app).add(key, value);
