import type { ChatMessage } from '../llm/types.js';

export interface ConversationState {
  id: string;
  title: string;
  buffer: ChatMessage[];
  bufferTokenCount: number;
  turnCount: number;
}

export interface ConversationTurn {
  userMessage: string;
  assistantResponse: string;
  tokensUsed: number;
}
