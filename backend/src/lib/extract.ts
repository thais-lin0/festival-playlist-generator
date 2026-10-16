import { betaRefusalFallbackMiddleware } from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import AnthropicBedrock, { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { BedrockRuntimeClient, ConverseCommand, type ToolInputSchema } from "@aws-sdk/client-bedrock-runtime";
import { DetectDocumentTextCommand, TextractClient } from "@aws-sdk/client-textract";
import { z } from "zod";
import type { LineupArtist } from "../../../lib/types";
import { log } from "./log";
import { normalize } from "./normalize";

// Configured per deployment (backend/cdk.json context):
//  - provider "nova":   Amazon Nova via the Bedrock Converse API (default; no extra access form needed)
//  - provider "claude": Anthropic Claude, either on the Mantle endpoint (current models,
//    bedrockApi "mantle") or via InvokeModel (Opus 4.6 and older, bedrockApi "invoke")
const PROVIDER: "nova" | "claude" = process.env.BEDROCK_PROVIDER === "claude" ? "claude" : "nova";
export const MODEL = process.env.BEDROCK_MODEL_ID ?? "us.amazon.nova-pro-v1:0";
const CLAUDE_API: "mantle" | "invoke" = process.env.BEDROCK_API === "invoke" ? "invoke" : "mantle";
// Bedrock has no server-side `fallbacks`; on Mantle the SDK middleware retries a
// policy refusal on this model instead.
const CLAUDE_FALLBACK_MODEL = process.env.BEDROCK_FALLBACK_MODEL_ID ?? "anthropic.claude-opus-4-8";

const ArtistSchema = z.object({
  name: z.string(),
  day: z.string().nullish(),
  genre: z.string().nullish(),
  tier: z.enum(["headliner", "main", "undercard"]).catch("undercard"),
});
const PosterSchema = z.object({
  festival_name: z.string().nullish(),
  edition: z.string().nullish(),
  days: z.array(z.string()).default([]),
  artists: z.array(ArtistSchema),
});
type Poster = z.infer<typeof PosterSchema>;

// Hand-written so every provider accepts it (no anyOf/nullable unions).
const POSTER_JSON_SCHEMA = {
  type: "object",
  properties: {
    festival_name: { type: "string", description: "Festival name without the year, title case" },
    edition: { type: "string", description: "Year or edition, e.g. '2027'" },
    days: { type: "array", items: { type: "string" }, description: "Festival days in poster order, in Portuguese (e.g. 'Sexta', 'Sábado')" },
    artists: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Artist name with correct spelling and capitalization" },
          day: { type: "string", description: "One of `days`; omit if the poster doesn't say" },
          genre: {
            type: "string",
            enum: ["pop", "rock", "indie", "eletrônico", "rap", "r&b", "funk", "sertanejo", "mpb", "metal", "reggae", "latino", "alternativo", "outro"],
            description: "Main genre; 'outro' if unknown",
          },
          tier: { type: "string", enum: ["headliner", "main", "undercard"] },
        },
        required: ["name", "tier", "genre"],
      },
    },
  },
  required: ["days", "artists"],
};

const SYSTEM = `You read music festival line-up posters. Extract every performing artist exactly once, top to bottom, in poster order.

- Fix OCR-style errors and stylized typography so names match how the artist is listed on streaming services (e.g. "TYLER, THE CREATOR" -> "Tyler, The Creator", "CHARLI XCX" -> "Charli xcx").
- Separators such as "·", "•", "|" or "/" split different artists on the same line.
- Skip sponsors, stage names, dates, ticket text, "and more", and DJ/host credits that aren't performances.
- tier: "headliner" for the largest type, "main" for the second size, "undercard" for the rest.
- day: only when the poster assigns the artist to a day. Never guess a day.
- genre: always give your best estimate from what you know about the artist; use "outro" only for artists you have never heard of.
- festival_name without the year; put the year or edition in edition. Use title case for the festival name and days (e.g. "Sexta"), not all caps.
- When OCR text is provided, use it to read small or stylized names, but trust the image for layout, days and type size; OCR lines can merge or split names.`;

const textract = new TextractClient({});

/** Textract OCR as a hint for small print. Optional: failures are logged and skipped. */
export async function ocrLines(image: Uint8Array): Promise<string[]> {
  try {
    const out = await textract.send(new DetectDocumentTextCommand({ Document: { Bytes: image } }));
    return (out.Blocks ?? []).filter((b) => b.BlockType === "LINE" && b.Text && (b.Confidence ?? 0) > 50).map((b) => b.Text!);
  } catch (error) {
    log.warn("textract failed, continuing with image only", { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

export interface ExtractedPoster {
  festival: string | null;
  edition: string | null;
  days: string[];
  artists: LineupArtist[];
}

export async function interpretPoster(image: Uint8Array, mediaType: "image/jpeg" | "image/png", ocr: string[]): Promise<ExtractedPoster> {
  const hint = ocr.length > 0 ? `OCR text from the poster (may contain errors):\n${ocr.join("\n")}` : null;
  const poster = PROVIDER === "nova" ? await withNova(image, mediaType, hint) : await withClaude(image, mediaType, hint);
  return tidy(poster);
}

// ---------- Amazon Nova (Converse API, forced tool call for structured output) ----------

let runtime: BedrockRuntimeClient | null = null;

async function withNova(image: Uint8Array, mediaType: "image/jpeg" | "image/png", hint: string | null): Promise<Poster> {
  runtime ??= new BedrockRuntimeClient({});
  const out = await runtime.send(
    new ConverseCommand({
      modelId: MODEL,
      system: [{ text: SYSTEM }],
      messages: [
        {
          role: "user",
          content: [
            { image: { format: mediaType === "image/png" ? "png" : "jpeg", source: { bytes: image } } },
            ...(hint ? [{ text: hint }] : []),
            { text: "Extract the line-up from this poster and save it with the save_lineup tool." },
          ],
        },
      ],
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: "save_lineup",
              description: "Save the festival line-up read from the poster.",
              inputSchema: { json: POSTER_JSON_SCHEMA } as ToolInputSchema,
            },
          },
        ],
        toolChoice: { tool: { name: "save_lineup" } },
      },
      // Greedy decoding is recommended for Nova tool use.
      inferenceConfig: { maxTokens: 8000, temperature: 0 },
    }),
  );

  log.info("bedrock response", {
    model: MODEL,
    stopReason: out.stopReason,
    inputTokens: out.usage?.inputTokens,
    outputTokens: out.usage?.outputTokens,
  });
  const toolUse = out.output?.message?.content?.find((c) => c.toolUse)?.toolUse;
  const parsed = PosterSchema.safeParse(toolUse?.input);
  if (!parsed.success) throw new Error("A leitura do cartaz não retornou um resultado válido.");
  return parsed.data;
}

// ---------- Anthropic Claude (kept for when Claude access is granted on the account) ----------

const ClaudePosterSchema = z.object({
  festival_name: z.string().nullable(),
  edition: z.string().nullable(),
  days: z.array(z.string()),
  artists: z.array(z.object({ name: z.string(), day: z.string().nullable(), genre: z.string().nullable(), tier: z.enum(["headliner", "main", "undercard"]) })),
});

type ClaudeClient = AnthropicBedrockMantle | AnthropicBedrock;
let claude: ClaudeClient | null = null;

async function withClaude(image: Uint8Array, mediaType: "image/jpeg" | "image/png", hint: string | null): Promise<Poster> {
  claude ??=
    CLAUDE_API === "mantle"
      ? new AnthropicBedrockMantle({
          awsRegion: process.env.AWS_REGION,
          middleware: [betaRefusalFallbackMiddleware([{ model: CLAUDE_FALLBACK_MODEL }])],
        })
      : new AnthropicBedrock({ awsRegion: process.env.AWS_REGION });

  const content: Parameters<ClaudeClient["beta"]["messages"]["parse"]>[0]["messages"][number]["content"] = [
    { type: "image", source: { type: "base64", media_type: mediaType, data: Buffer.from(image).toString("base64") } },
  ];
  if (hint) content.push({ type: "text", text: hint });
  content.push({ type: "text", text: "Extract the line-up from this poster." });

  const response = await claude.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium", format: betaZodOutputFormat(ClaudePosterSchema) },
    system: SYSTEM,
    messages: [{ role: "user", content }],
  });

  log.info("bedrock response", {
    model: response.model,
    stopReason: response.stop_reason,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  });
  if (response.stop_reason === "refusal") throw new Error("Não foi possível analisar esta imagem.");
  if (!response.parsed_output) throw new Error("A leitura do cartaz não retornou um resultado válido.");
  return response.parsed_output;
}

// ---------- shared post-processing ----------

function tidy(poster: Poster): ExtractedPoster {
  const days = poster.days.map((d) => d.trim()).filter(Boolean);
  const seen = new Set<string>();
  const artists: LineupArtist[] = [];
  for (const a of poster.artists) {
    const key = normalize(a.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    artists.push({
      id: `a${artists.length}`,
      name: a.name.trim(),
      day: a.day && days.includes(a.day) ? a.day : null,
      genre: a.genre && a.genre.toLowerCase() !== "outro" ? a.genre.toLowerCase() : null,
      tier: a.tier,
      order: artists.length,
    });
  }
  return { festival: poster.festival_name || null, edition: poster.edition || null, days, artists };
}
