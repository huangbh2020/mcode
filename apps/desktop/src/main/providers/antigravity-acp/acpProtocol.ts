/**
 * ACP (Agent Client Protocol) JSON-RPC 2.0 wire types, schemas, and error types
 * tailored for Antigravity CLI (`agy acp`).
 */
import { z } from "zod";

export const ACP_PROTOCOL_VERSION = 1;
export const ACP_AUTH_REQUIRED_CODE = -32000;

// ── Errors ──────────────────────────────────────────────────────────────────

export class AcpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpRpcError";
  }
}

export class AcpAuthRequiredError extends AcpRpcError {
  constructor(message = "Authentication required", data?: unknown) {
    super(ACP_AUTH_REQUIRED_CODE, message, data);
    this.name = "AcpAuthRequiredError";
  }
}

export class AcpConnectionClosedError extends Error {
  constructor(
    message = "ACP connection closed",
    readonly stderrTail?: string,
  ) {
    super(message);
    this.name = "AcpConnectionClosedError";
  }
}

export class AcpAbortedError extends Error {
  constructor(message = "ACP turn aborted") {
    super(message);
    this.name = "AbortError";
  }
}

// ── JSON-RPC Envelope ───────────────────────────────────────────────────────

export const AcpRpcEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});

// ── Initialize & Session Setup ──────────────────────────────────────────────

export const AcpInitializeResponseSchema = z
  .object({
    protocolVersion: z.number(),
    agentCapabilities: z
      .object({
        loadSession: z.boolean().optional(),
        promptCapabilities: z
          .object({
            image: z.boolean().optional(),
            audio: z.boolean().optional(),
            embeddedContext: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
        sessionCapabilities: z
          .object({
            resume: z.unknown().optional(),
            load: z.unknown().optional(),
            list: z.unknown().optional(),
            close: z.unknown().optional(),
          })
          .passthrough()
          .optional(),
        _meta: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
    agentInfo: z
      .object({
        name: z.string().optional(),
        version: z.string().optional(),
      })
      .passthrough()
      .optional(),
    authMethods: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string().optional(),
            description: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
export type AcpInitializeResponse = z.infer<typeof AcpInitializeResponseSchema>;

export const AcpSessionResponseSchema = z
  .object({
    sessionId: z.string(),
    models: z
      .object({
        currentModelId: z.string().optional(),
        availableModels: z
          .array(
            z
              .object({
                modelId: z.string(),
                name: z.string(),
                description: z.string().optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .optional(),
    modes: z
      .object({
        currentModeId: z.string().optional(),
        availableModes: z
          .array(
            z
              .object({
                id: z.string(),
                name: z.string(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type AcpSessionResponse = z.infer<typeof AcpSessionResponseSchema>;

export const AcpPromptResponseSchema = z
  .object({
    stopReason: z.string().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type AcpPromptResponse = z.infer<typeof AcpPromptResponseSchema>;

// ── Prompt Content Blocks ───────────────────────────────────────────────────

export type AcpPromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

// ── Session Notifications (`session/update`) ────────────────────────────────

export const AcpTextContentSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .passthrough();

export const AcpToolCallContentItemSchema = z
  .object({
    type: z.string(),
    content: z
      .object({
        type: z.string(),
        text: z.string().optional(),
        data: z.string().optional(),
        mimeType: z.string().optional(),
      })
      .passthrough()
      .optional(),
    path: z.string().optional(),
    oldText: z.string().optional(),
    newText: z.string().optional(),
  })
  .passthrough();

export const AcpToolCallUpdateSchema = z
  .object({
    sessionUpdate: z.enum(["tool_call", "tool_call_update"]),
    toolCallId: z.string(),
    title: z.string().optional(),
    name: z.string().optional(),
    kind: z.string().optional(),
    status: z.enum(["pending", "in_progress", "completed", "failed"]).optional(),
    rawInput: z.unknown().optional(),
    rawOutput: z.unknown().optional(),
    content: z.array(AcpToolCallContentItemSchema).nullish(),
    locations: z
      .array(
        z
          .object({
            path: z.string().optional(),
            line: z.number().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
export type AcpToolCallUpdate = z.infer<typeof AcpToolCallUpdateSchema>;

export const AcpPlanUpdateSchema = z
  .object({
    sessionUpdate: z.literal("plan"),
    entries: z.array(
      z
        .object({
          content: z.string(),
          status: z.string().optional(),
          priority: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const AcpUsageUpdateSchema = z
  .object({
    sessionUpdate: z.literal("usage_update"),
    used: z.number().optional(),
    size: z.number().optional(),
    cost: z
      .object({
        amount: z.number().optional(),
        currency: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const AcpMessageChunkSchema = z
  .object({
    sessionUpdate: z.enum(["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"]),
    messageId: z.string().optional(),
    content: z
      .object({
        type: z.string(),
        text: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const AcpSessionNotificationSchema = z
  .object({
    sessionId: z.string(),
    update: z
      .object({
        sessionUpdate: z.string(),
      })
      .passthrough(),
    _meta: z
      .object({
        isReplay: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// ── Incoming Requests (`session/request_permission` & `elicitation/create`) ─

export const AcpPermissionOptionSchema = z
  .object({
    optionId: z.string(),
    name: z.string(),
    kind: z.string().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const AcpRequestPermissionSchema = z
  .object({
    sessionId: z.string(),
    toolCall: z
      .object({
        toolCallId: z.string(),
        title: z.string().optional(),
        kind: z.string().optional(),
        rawInput: z.unknown().optional(),
        locations: z
          .array(
            z
              .object({
                path: z.string().optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough(),
    options: z.array(AcpPermissionOptionSchema),
  })
  .passthrough();
export type AcpRequestPermissionParams = z.infer<typeof AcpRequestPermissionSchema>;

export const AcpElicitationChoiceSchema = z
  .object({
    const: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
  })
  .passthrough();

export const AcpElicitationPropertySchema = z
  .object({
    type: z.enum(["string", "boolean", "array"]),
    title: z.string().optional(),
    description: z.string().optional(),
    format: z.string().optional(),
    default: z.unknown().optional(),
    enum: z.array(z.string()).optional(),
    oneOf: z.array(AcpElicitationChoiceSchema).optional(),
    items: z
      .object({
        enum: z.array(z.string()).optional(),
        anyOf: z.array(AcpElicitationChoiceSchema).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const AcpElicitationFormSchema = z
  .object({
    sessionId: z.string().optional(),
    mode: z.literal("form"),
    message: z.string(),
    requestedSchema: z
      .object({
        properties: z.record(z.string(), AcpElicitationPropertySchema),
        required: z.array(z.string()).optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type AcpElicitationFormParams = z.infer<typeof AcpElicitationFormSchema>;

/** Extract human-readable words from an ACP error's `data` field. */
export function extractAcpErrorText(data: unknown): string | undefined {
  if (typeof data === "string") {
    const trimmed = data.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["message", "detail", "details", "error"]) {
      const val = record[key];
      if (typeof val === "string" && val.trim().length > 0) return val.trim();
    }
  }
  return undefined;
}
