import OpenAI from 'openai';
import { config } from '../config/index.js';
import type { ChatMessage, CompletionOptions } from './types.js';

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      baseURL: config.llmBaseUrl,
      apiKey: config.llmApiKey,
    });
  }
  return client;
}

/**
 * Non-streaming chat completion. Returns the full response text.
 */
export async function chatCompletion(
  messages: ChatMessage[],
  options?: CompletionOptions
): Promise<string> {
  const c = getClient();
  const response = await c.chat.completions.create({
    model: options?.model || config.llmModel,
    messages,
    temperature: options?.temperature ?? 0.7,
    max_tokens: options?.maxTokens,
  });
  return response.choices[0]?.message?.content || '';
}

/**
 * Streaming chat completion. Yields text chunks as they arrive.
 */
export async function* streamChatCompletion(
  messages: ChatMessage[],
  options?: CompletionOptions
): AsyncIterable<string> {
  const c = getClient();
  const stream = await c.chat.completions.create({
    model: options?.model || config.llmModel,
    messages,
    temperature: options?.temperature ?? 0.7,
    max_tokens: options?.maxTokens,
    stream: true,
  });
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      yield delta;
    }
  }
}
