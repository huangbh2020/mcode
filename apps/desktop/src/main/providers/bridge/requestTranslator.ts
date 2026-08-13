/**
 * Request translator: Anthropic `/v1/messages` body → OpenAI `/v1/chat/completions` body.
 *
 * The bridge receives Anthropic-formatted requests from the Claude binary and
 * must re-shape them into OpenAI's Chat Completions format before forwarding
 * to the real upstream endpoint. This module is a pure function — no I/O — so
 * it's trivially unit-testable.
 *
 * ## Key shape differences handled here
 *
 * 1. **System prompt**: Anthropic carries `system` as a top-level field; OpenAI
 *    wants it as the first `{role:"system"}` message.
 * 2. **Content blocks vs. strings**: Anthropic's `messages[].content` is either
 *    a plain string or an array of typed blocks. OpenAI uses a flat `content`
 *    string for user/assistant text, and a separate `tool_calls` array for the
 *    assistant's tool invocations.
 * 3. **Tool results**: Anthropic nests `tool_result` blocks inside a user
 *    message's content array; OpenAI wants each result as its own
 *    `{role:"tool", tool_call_id, content}` message.
 * 4. **Tool definitions**: Anthropic's `input_schema` becomes OpenAI's
 *    `function.parameters`; `tool_choice` enum values map across.
 * 5. **Images**: Anthropic image blocks (base64 source) become OpenAI
 *    `image_url` data-URL parts in the user message's `content` array — the
 *    vision input format for OpenAI-protocol endpoints. Without this, the
 *    model never sees user-attached images and replies "你还没有提供图片".
 * 6. **Dropped fields**: `thinking` (no OpenAI equivalent), `cache_control`
 *    (OpenAI caches automatically). These are intentionally NOT forwarded.
 */
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicTool,
  AnthropicToolChoice,
  OpenAIContentPart,
  OpenAIMessage,
  OpenAIRequest,
  OpenAITool,
} from "./types.js";

/** Extract the text from a possibly-(block-array|string) content value. */
function joinText(content: string | AnthropicContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Translate one Anthropic message into one or more OpenAI messages.
 *
 *  - A plain user/assistant text message → 1 OpenAI message.
 *  - An assistant message with tool_use blocks → the text (if any) goes to
 *    `content`, and each tool_use becomes an entry in `tool_calls`.
 *  - A user message containing tool_result blocks → one OpenAI `{role:"tool"}`
 *    message PER result (plus a trailing user message if there's free text).
 */
function translateMessage(msg: AnthropicMessage): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];

  // Plain string content — the common case, no tool involvement.
  if (typeof msg.content === "string") {
    out.push({ role: msg.role, content: msg.content });
    return out;
  }

  if (msg.role === "assistant") {
    // Accumulate text into `content` and tool_use into `tool_calls`.
    const text: string[] = [];
    const toolCalls: NonNullable<OpenAIMessage["tool_calls"]> = [];
    for (const block of msg.content) {
      if (block.type === "text") {
        text.push(block.text);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            // Anthropic's `input` is a JSON object; OpenAI wants it as a JSON
            // string. Empty/absent input → "{}" (OpenAI rejects bare "").
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      }
      // thinking blocks are dropped — they have no OpenAI representation and
      // the upstream can't act on them.
    }
    const oai: OpenAIMessage = { role: "assistant" };
    if (text.length > 0) oai.content = text.join("");
    if (toolCalls.length > 0) oai.tool_calls = toolCalls;
    // OpenAI requires assistant messages to carry content or tool_calls; if
    // neither (shouldn't happen), emit empty content to stay well-formed.
    if (oai.content === undefined && oai.tool_calls === undefined) oai.content = "";
    out.push(oai);
    return out;
  }

  // user message: split tool_result blocks into separate tool messages, and
  // surface any remaining text + images as the user's own message.
  const userText: string[] = [];
  const userImages: OpenAIContentPart[] = [];
  for (const block of msg.content) {
    if (block.type === "tool_result") {
      let resultText = typeof block.content === "string"
        ? block.content
        : Array.isArray(block.content)
          // OpenAI tool messages are text-only; image blocks inside a tool
          // result (e.g. Read on an image file) have no representation there
          // and are dropped.
          ? block.content
              .filter((t): t is { type: "text"; text: string } => t.type === "text")
              .map((t) => t.text)
              .join("")
          : "";
      // OpenAI has no `is_error` flag; fold the error hint into the text so the
      // model still sees that the tool call failed (mirrors what Claude does).
      if (block.is_error && resultText) resultText = `[ERROR] ${resultText}`;
      out.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: resultText,
      });
    } else if (block.type === "text") {
      userText.push(block.text);
    } else if (block.type === "image") {
      // Anthropic image block → OpenAI image_url part. Anthropic carries the
      // media type + raw base64 separately; OpenAI wants a full data: URL.
      if (block.source.type === "base64") {
        userImages.push({
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        });
      }
      // Non-base64 sources (url) can't occur in our flow; ignored defensively.
    }
    // thinking blocks can't appear in a user message; ignored defensively.
  }
  const userParts: OpenAIContentPart[] = [];
  if (userText.length > 0) userParts.push({ type: "text", text: userText.join("") });
  userParts.push(...userImages);
  if (userParts.length > 0) {
    // No images → keep the plain string form (wire payload identical to
    // before this change). Images → parts array, text part first.
    out.push({
      role: "user",
      content: userImages.length === 0 ? (userParts[0].text ?? "") : userParts,
    });
  }
  return out;
}

function translateTools(tools: AnthropicTool[]): OpenAITool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function translateToolChoice(tc: AnthropicToolChoice): OpenAIRequest["tool_choice"] {
  switch (tc.type) {
    case "auto":
      return "auto";
    case "any":
      // Anthropic's "any" = "the model must call a tool" → OpenAI's "required".
      return "required";
    case "tool":
      return { type: "function", function: { name: tc.name } };
    case "none":
      return "none";
  }
}

/** Translate an Anthropic request body into an OpenAI request body. Pure. */
export function anthropicToOpenAI(req: AnthropicRequest): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  // System prompt: Anthropic top-level field → leading system message(s).
  if (typeof req.system === "string" && req.system.length > 0) {
    messages.push({ role: "system", content: req.system });
  } else if (Array.isArray(req.system)) {
    const sysText = joinText(req.system);
    if (sysText.length > 0) messages.push({ role: "system", content: sysText });
  }

  for (const msg of req.messages) {
    messages.push(...translateMessage(msg));
  }

  const out: OpenAIRequest = {
    model: req.model,
    messages,
    max_tokens: req.max_tokens,
    stream: req.stream,
  };
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop_sequences && req.stop_sequences.length > 0) out.stop = req.stop_sequences;
  if (req.tools && req.tools.length > 0) out.tools = translateTools(req.tools);
  if (req.tool_choice) out.tool_choice = translateToolChoice(req.tool_choice);
  return out;
}
