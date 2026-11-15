import { randomUUID } from 'node:crypto';

type TextBlock = { text: string; lastSent: string; sentAt: number; final: boolean };
type StreamItem = { type: string; item: { id: string; type: 'agent_message'; text: string } };

// Claude emits both text deltas and complete blocks. Keep the same item identity
// for both so clients replace the growing message instead of adding duplicates.
export class ClaudeTextStream {
  private messageId = '';
  private blocks = new Map<number, TextBlock>();
  private index = -1;
  private seen = new Set<string>();
  private publish: (event: StreamItem) => void;
  private now: () => number;
  constructor(publish: (event: StreamItem) => void, now = Date.now) {
    this.publish = publish;
    this.now = now;
  }
  private send(index: number, block: TextBlock, complete = false) {
    this.publish({
      type: complete ? 'item.completed' : 'item.updated',
      item: {
        id: `claude:${this.messageId}:${index}`,
        type: 'agent_message',
        text: block.text,
      },
    });
    block.lastSent = block.text;
    block.sentAt = this.now();
  }
  flush() {
    for (const [index, block] of this.blocks)
      if (!block.final && block.text !== block.lastSent) this.send(index, block);
  }
  consume(value: any) {
    // Subagent output is not the main assistant's response.
    if (value.parent_tool_use_id) return;
    if (value.type === 'stream_event') {
      const event = value.event;
      if (event?.type === 'message_start') {
        this.flush();
        this.messageId = event.message?.id || randomUUID();
        this.blocks.clear();
        this.index = -1;
      } else if (event?.type === 'content_block_start') {
        this.index = event.index;
        if (event.content_block?.type === 'text')
          this.blocks.set(event.index, {
            text: event.content_block.text || '',
            lastSent: '',
            sentAt: -Infinity,
            final: false,
          });
      } else if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const block = this.blocks.get(event.index);
        if (block && !block.final && typeof event.delta.text === 'string') {
          block.text += event.delta.text;
          if (this.now() - block.sentAt >= 50) this.send(event.index, block);
        }
      } else if (event?.type === 'message_stop') this.flush();
      return;
    }
    if (value.type !== 'assistant') return;
    if (value.uuid && this.seen.has(value.uuid)) return;
    if (value.uuid) this.seen.add(value.uuid);
    const texts = (value.message?.content || []).filter((block: any) => block.type === 'text');
    if (!texts.length) return;
    const id = value.message?.id || randomUUID();
    for (let offset = 0; offset < texts.length; offset++) {
      const text = texts[offset].text;
      if (typeof text !== 'string') continue;
      if (id === this.messageId) {
        const active = texts.length === 1 ? this.blocks.get(this.index) : undefined;
        const match =
          active && !active.final
            ? ([this.index, active] as const)
            : [...this.blocks.entries()].find(([, b]) => b.text === text);
        if (match) {
          match[1].text = text;
          match[1].final = true;
          this.send(match[0], match[1], true);
          continue;
        }
      }
      // Complete-only messages remain supported if no partial events arrived.
      this.publish({
        type: 'item.completed',
        item: {
          id: `claude:${id}:${value.uuid || randomUUID()}:${offset}`,
          type: 'agent_message',
          text,
        },
      });
    }
  }
}
