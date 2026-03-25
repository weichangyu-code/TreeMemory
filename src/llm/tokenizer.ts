import { encode } from 'gpt-tokenizer';
import type { ChatMessage } from './types.js';

const PER_MESSAGE_OVERHEAD = 4; // <|im_start|>role\n...\n<|im_end|>

/**
 * Count tokens in a plain text string.
 */
export function countTokens(text: string): number {
  return encode(text).length;
}

/**
 * Count tokens for an array of chat messages,
 * accounting for per-message overhead matching OpenAI's format.
 */
export function countMessagesTokens(messages: ChatMessage[]): number {
  let total = 3; // every reply is primed with <|start|>assistant<|message|>
  for (const msg of messages) {
    total += PER_MESSAGE_OVERHEAD;
    total += countTokens(msg.role);
    total += countTokens(msg.content);
  }
  return total;
}
