/** Assemble OpenAI-compatible SSE without executing incomplete tool calls. */
export async function readCompletion(response: Response, onText: (text: string) => void) {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return response.json();
  if (!response.body) throw new Error('Provider returned an empty stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '',
    content = '',
    reasoning = '',
    finished = false,
    done = false;
  let usage: unknown;
  let received = 0;
  const calls = new Map<number, any>();
  function consume(frame: string) {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') {
      done = true;
      return;
    }
    const chunk = JSON.parse(data);
    if (chunk.error) throw new Error('Provider stream reported an error');
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.find((c: any) => c.index === 0) ?? chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason != null) {
      if (!['stop', 'tool_calls', 'function_call'].includes(choice.finish_reason))
        throw new Error('Provider response ended before completion: ' + choice.finish_reason);
      finished = true;
    }
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') {
      content += delta.content;
      onText(content);
    }
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    for (const part of delta.tool_calls || []) {
      if (!Number.isInteger(part.index) || part.index < 0 || part.index > 127)
        throw new Error('Invalid streamed tool index');
      const call = calls.get(part.index) || {
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
      };
      if (part.id) call.id = part.id;
      if (part.function?.name) call.function.name += part.function.name;
      if (part.function?.arguments) call.function.arguments += part.function.arguments;
      calls.set(part.index, call);
    }
  }
  try {
    while (!done) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > 16 * 1024 * 1024)
        throw new Error('Provider stream exceeded the response limit');
      pending += decoder.decode(next.value, { stream: true });
      // Normalize complete CRLF pairs; a trailing CR is retained across chunks.
      pending = pending.replace(/\r\n/g, '\n');
      if (pending.length > 4 * 1024 * 1024 || content.length + reasoning.length > 4 * 1024 * 1024)
        throw new Error('Provider stream exceeded the response limit');
      let end;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        consume(frame);
        if (done) break;
      }
    }
    if (!finished) throw new Error('Provider stream disconnected before completion');
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    if (toolCalls.some((call) => !call.id || !call.function.name))
      throw new Error('Incomplete streamed tool call');
    return {
      choices: [
        {
          message: {
            role: 'assistant',
            content: content || null,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
        },
      ],
      usage,
    };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
