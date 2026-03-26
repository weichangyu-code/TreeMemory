import { config } from '../config/index.js';
import { chatCompletion } from '../llm/client.js';
import { countTokens, countMessagesTokens } from '../llm/tokenizer.js';
import * as knowledgeTree from '../memory/knowledge-tree.js';
import { recall } from '../memory/recall.js';
import { CHAT_SYSTEM_PROMPT, BUFFER_SUMMARY_PROMPT } from '../prompts/index.js';
import type { ChatMessage } from '../llm/types.js';
import type { RecallResult } from '../memory/types.js';

/**
 * Check if the current buffer exceeds the summarization threshold.
 */
export function shouldSummarize(bufferTokenCount: number): boolean {
  return bufferTokenCount >= config.maxContextTokens * config.summarizeThresholdRatio;
}

/**
 * Summarize the oldest half of the message buffer using LLM.
 * Returns the summary text and the number of messages summarized.
 */
export async function summarizeBuffer(
  buffer: ChatMessage[]
): Promise<{ summary: string; count: number }> {
  const halfIndex = Math.ceil(buffer.length / 2);
  const toSummarize = buffer.slice(0, halfIndex);

  const text = toSummarize
    .map((m) => `[${m.role}] ${m.content}`)
    .join('\n');

  const summary = await chatCompletion([
    {
      role: 'system',
      content: BUFFER_SUMMARY_PROMPT,
    },
    { role: 'user', content: text },
  ], { temperature: 0.3 });

  return { summary, count: halfIndex };
}

/**
 * Assemble the final prompt to send to the LLM.
 *
 * Structure:
 * 1. System message (base prompt + knowledge context)
 * 2. Summary of older history (if any)
 * 3. Recent conversation messages
 * 4. Current user message (already in buffer)
 */
export function assemblePrompt(
  buffer: ChatMessage[],
  recallResult: RecallResult,
  historySummary?: string
): ChatMessage[] {
  const messages: ChatMessage[] = [];

  // 1. System message with knowledge context
  const knowledgeContext = knowledgeTree.toContextString(recallResult.knowledgeContext);
  let systemContent = CHAT_SYSTEM_PROMPT;
  if (knowledgeContext) {
    systemContent += '\n\n' + knowledgeContext;
  }
  messages.push({ role: 'system', content: systemContent });

  // 2. Historical summaries from temporal tree
  const temporalSummaries = recallResult.temporalContext.filter((n) => n.level > 0);
  if (temporalSummaries.length > 0) {
    const summaryText = temporalSummaries
      .map((s) => `[${s.timeStart.slice(0, 16)}] ${s.content}`)
      .join('\n');
    messages.push({
      role: 'system',
      content: `## 历史对话摘要\n${summaryText}`,
    });
  }

  // 3. Buffer summary (from inline summarization)
  if (historySummary) {
    messages.push({
      role: 'system',
      content: `## 本次对话早期摘要\n${historySummary}`,
    });
  }

  // 4. Current conversation buffer (recent messages)
  messages.push(...buffer);

  return messages;
}

/**
 * Calculate the available token budget for recall,
 * given the current buffer and user message.
 */
export function calculateRecallBudget(buffer: ChatMessage[]): number {
  const systemTokens = countTokens(CHAT_SYSTEM_PROMPT) + 50; // buffer for knowledge
  const bufferTokens = countMessagesTokens(buffer);
  const responseReserve = Math.min(2048, Math.floor(config.maxContextTokens * 0.15));
  const available = config.maxContextTokens - systemTokens - bufferTokens - responseReserve;
  return Math.max(0, available);
}
