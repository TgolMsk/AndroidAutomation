/** Shared fakes of the AI tests: a scripted OpenAI-compatible endpoint and chat/completions bodies. */
import type { VisionFetch } from '../../src/main/automation/advisor/client';

export interface FakeCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface FakeReply {
  status: number;
  body: string;
  throwWith?: () => Error;
}

/** A chat/completions success body. */
export function chatBody(content: string, model = 'fake-vl'): string {
  return JSON.stringify({ model, choices: [{ message: { role: 'assistant', content } }] });
}

/** Scripted provider: replies are consumed in order, then `fallback` (「看不出来」, no action). */
export class FakeApi {
  readonly calls: FakeCall[] = [];
  private script: FakeReply[] = [];
  fallback: FakeReply = {
    status: 200,
    body: chatBody('{"screen":"unknown","action":"none","target":null,"confidence":0.3,"reason":"看不出来"}'),
  };

  queue(...replies: FakeReply[]): void { this.script.push(...replies); }

  reset(): void {
    this.script = [];
    this.calls.length = 0;
  }

  readonly fetch: VisionFetch = async (url, init) => {
    this.calls.push({ url, headers: init.headers, body: init.body });
    const reply = this.script.shift() ?? this.fallback;
    if (reply.throwWith) throw reply.throwWith();
    return { status: reply.status, text: async () => reply.body };
  };
}

/** The user message's image data URL of a recorded call. */
export function imageUrlOf(call: FakeCall): string {
  const body = JSON.parse(call.body) as { messages: Array<{ content: unknown }> };
  const parts = body.messages[1]!.content as Array<{ type: string; image_url?: { url: string } }>;
  return parts.find((part) => part.type === 'image_url')?.image_url?.url ?? '';
}
