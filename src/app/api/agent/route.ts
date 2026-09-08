import Anthropic from "@anthropic-ai/sdk";
import { EdlSchema } from "@/lib/edl/types";
import { applyTool, describeState, SYSTEM_PROMPT, TOOLS, type AgentContext } from "@/lib/agent/tools";

/** The loop can run several model turns; give it room. */
export const maxDuration = 300;

interface Body {
  prompt: string;
  edl: unknown;
  context: AgentContext;
  /** Prior turns, so follow-ups like "actually, undo the last bit" work. */
  history?: Anthropic.MessageParam[];
}

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      { error: "No ANTHROPIC_API_KEY. Add it to .env.local and restart the dev server." },
      { status: 501 },
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "Malformed request body." }, { status: 400 });
  }

  const parsed = EdlSchema.safeParse(body.edl);
  if (!parsed.success) {
    return Response.json({ error: "Invalid edit document." }, { status: 400 });
  }

  const client = new Anthropic();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

      // The document is threaded through the loop, not stored — the client
      // owns state, the server just transforms it.
      let edl = parsed.data;
      const ctx = body.context ?? { media: [], analysis: { silences: {} } };
      const messages: Anthropic.MessageParam[] = [
        ...(body.history ?? []),
        {
          role: "user",
          content: `Current edit:\n\n${describeState(edl, ctx)}\n\n---\n\nRequest: ${body.prompt}`,
        },
      ];

      try {
        // Cap the turns so a confused model cannot spend forever.
        for (let turn = 0; turn < 12; turn++) {
          const response = await client.messages
            .stream({
              model: "claude-opus-5",
              max_tokens: 32000,
              thinking: { type: "adaptive" },
              output_config: { effort: "high" },
              system: SYSTEM_PROMPT,
              tools: TOOLS,
              messages,
            })
            .finalMessage();

          for (const block of response.content) {
            if (block.type === "text" && block.text.trim()) {
              send({ type: "text", text: block.text });
            }
          }

          if (response.stop_reason !== "tool_use") break;

          messages.push({ role: "assistant", content: response.content });

          const results: Anthropic.ToolResultBlockParam[] = [];
          for (const block of response.content) {
            if (block.type !== "tool_use") continue;
            // Inputs may arrive with varied escaping — never string-match them.
            const input = (block.input ?? {}) as Record<string, unknown>;
            try {
              const outcome = applyTool(edl, ctx, block.name, input);
              edl = outcome.edl;
              send({ type: "tool", name: block.name, summary: outcome.summary, edl });
              results.push({ type: "tool_result", tool_use_id: block.id, content: outcome.result });
            } catch (err) {
              const message = err instanceof Error ? err.message : "Tool failed.";
              send({ type: "tool", name: block.name, summary: `Failed: ${message}`, edl });
              results.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: `Error: ${message}`,
                is_error: true,
              });
            }
          }
          // All results go back in one user message, or the model learns to
          // stop calling tools in parallel.
          messages.push({ role: "user", content: results });
        }

        send({ type: "done", edl });
      } catch (err) {
        let message = "The agent failed.";
        if (err instanceof Anthropic.AuthenticationError) message = "Invalid ANTHROPIC_API_KEY.";
        else if (err instanceof Anthropic.RateLimitError) message = "Rate limited — try again shortly.";
        else if (err instanceof Anthropic.APIError) message = `API error ${err.status}: ${err.message}`;
        else if (err instanceof Error) message = err.message;
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
