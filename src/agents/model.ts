import type {
  ModelClient,
  ModelRequest,
  ToolCall,
} from "wayline-agent-runtime";

export interface ModelOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Small non-streaming OpenAI Chat Completions adapter. No provider responses/keys in errors. */
export function openAICompatibleModel(options: ModelOptions): ModelClient {
  const endpoint = new URL(
    options.baseUrl.replace(/\/$/, "") + "/chat/completions",
  );
  if (
    !["https:", "http:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error("Invalid model endpoint");
  }
  if (
    endpoint.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
  ) {
    throw new Error("Remote model endpoint requires HTTPS");
  }
  if (!options.model.trim()) throw new Error("MODEL_ID is required");
  return {
    async complete(request: ModelRequest) {
      const messages: Record<string, unknown>[] = [];
      if (request.systemPrompt)
        messages.push({ role: "system", content: request.systemPrompt });
      for (const message of request.messages) {
        const calls = message.metadata?.toolCalls as ToolCall[] | undefined;
        messages.push({
          role: message.role,
          content: message.content || (calls?.length ? null : ""),
          ...(message.role === "tool"
            ? { tool_call_id: message.toolCallId }
            : {}),
          ...(message.role === "assistant" && calls?.length
            ? {
                tool_calls: calls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                  },
                })),
              }
            : {}),
        });
      }
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 90_000);
      const signal = request.signal
        ? AbortSignal.any([request.signal, timeout])
        : timeout;
      const response = await (options.fetch ?? fetch)(endpoint, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          ...(options.apiKey
            ? { Authorization: `Bearer ${options.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: options.model,
          messages,
          stream: false,
          ...(request.tools.length
            ? {
                tools: request.tools.map((tool) => ({
                  type: "function",
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                  },
                })),
              }
            : {}),
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Model request failed (HTTP ${response.status})`);
      }
      const body = (await response.json()) as {
        choices?: {
          message?: {
            content?: unknown;
            tool_calls?: {
              id: string;
              function: { name: string; arguments: string };
            }[];
          };
        }[];
      };
      const result = body.choices?.[0]?.message;
      if (!result) throw new Error("Model returned no message");
      const toolCalls = result.tool_calls?.map((call) => {
        let args: unknown;
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          throw new Error("Model returned invalid tool arguments");
        }
        if (!args || typeof args !== "object" || Array.isArray(args))
          throw new Error("Model returned non-object tool arguments");
        return {
          id: call.id,
          name: call.function.name,
          arguments: args as Record<string, unknown>,
        };
      });
      return {
        content: typeof result.content === "string" ? result.content : "",
        ...(toolCalls ? { toolCalls } : {}),
      };
    },
  };
}
