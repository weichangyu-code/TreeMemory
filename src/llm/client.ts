import OpenAI from 'openai';
import { config } from '../config/index.js';
import type { ChatMessage, CompletionOptions, ChatCompletionResult, ChatCompletionMessageToolCall } from './types.js';

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

/**
 * Full chat completion with tools support. Returns complete response including tool calls.
 */
export async function chatCompletionFull(
  messages: ChatMessage[],
  options?: CompletionOptions
): Promise<ChatCompletionResult> {
  const c = getClient();

  type CreateParams = Parameters<typeof c.chat.completions.create>[0] & { stream?: false };
  const createParams: CreateParams = {
    model: options?.model || config.llmModel,
    messages,
    temperature: options?.temperature ?? 0.7,
    max_tokens: options?.maxTokens,
    stream: false,
  };
  if (options?.tools && options.tools.length > 0) {
    createParams.tools = options.tools;
    if (options.toolChoice) {
      createParams.tool_choice = options.toolChoice;
    }
  }
  const response = await c.chat.completions.create(createParams);
  const choice = response.choices[0];
  return {
    content: choice?.message?.content || null,
    toolCalls: choice?.message?.tool_calls as ChatCompletionMessageToolCall[] | undefined,
    finishReason: choice?.finish_reason || 'stop',
  };
}
