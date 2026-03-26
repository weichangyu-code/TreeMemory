import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

// 使用 OpenAI SDK 原生类型作为 ChatMessage
export type ChatMessage = ChatCompletionMessageParam;

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  tools?: ChatCompletionTool[];
  toolChoice?: ChatCompletionToolChoiceOption;
}

export interface ChatCompletionResult {
  content: string | null;
  toolCalls?: ChatCompletionMessageToolCall[];
  finishReason: string;
}

// 重新导出 OpenAI 类型供外部使用
export type { ChatCompletionTool, ChatCompletionToolChoiceOption, ChatCompletionMessageToolCall };
