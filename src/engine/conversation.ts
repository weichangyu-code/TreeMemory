import { ulid } from 'ulid';
import { getDb } from '../db/connection.js';
import { streamChatCompletion, chatCompletionFull } from '../llm/client.js';
import { countTokens, countMessagesTokens } from '../llm/tokenizer.js';
import { getToolDefinitions, executeTool } from './tools.js';
import * as temporalTree from '../memory/temporal-tree.js';
import { recall } from '../memory/recall.js';
import {
  shouldSummarize,
  summarizeBuffer,
  assemblePrompt,
  calculateRecallBudget,
} from './context-manager.js';
import { nowISO } from '../utils/time.js';
import { logger } from '../utils/logger.js';
import { extractKnowledgeImmediate } from '../background/knowledge-extractor.js';
import type { ChatMessage } from '../llm/types.js';
import type { ConversationState } from './types.js';

const conversations = new Map<string, ConversationState>();

/**
 * Get or create a conversation state.
 */
export function getConversation(conversationId?: string): ConversationState {
  const id = conversationId || ulid();

  if (conversations.has(id)) {
    return conversations.get(id)!;
  }

  // Check database for existing conversation
  const db = getDb();
  const row = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;

  const state: ConversationState = {
    id: row ? (row.id as string) : id,
    title: row ? (row.title as string) : '',
    buffer: [],
    bufferTokenCount: 0,
    turnCount: 0,
  };

  if (!row) {
    // Create new conversation in DB
    const now = nowISO();
    db.prepare(`INSERT INTO conversations (id, title, created_at, last_message_at) VALUES (?, '', ?, ?)`).run(
      id,
      now,
      now
    );
  } else {
    // Load recent messages into buffer
    const messages = db
      .prepare(
        `SELECT role, content, token_count FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC`
      )
      .all(id) as { role: string; content: string; token_count: number }[];
    for (const msg of messages) {
      // 确保角色是有效的消息角色类型
      const role = msg.role as 'system' | 'user' | 'assistant';
      state.buffer.push({ role, content: msg.content });
      state.bufferTokenCount += msg.token_count;
    }
    state.turnCount = Math.floor(messages.length / 2);
  }

  conversations.set(id, state);
  return state;
}

// In-memory summary storage per conversation
const conversationSummaries = new Map<string, string>();

/**
 * Store a message in both the working buffer and persistent storage.
 */
function storeMessage(state: ConversationState, role: 'user' | 'assistant' | 'system', content: string): void {
  const db = getDb();
  const now = nowISO();
  const tokens = countTokens(content);
  const msgId = ulid();

  // Insert to temporal tree
  const temporalNode = temporalTree.insertLeaf(role, content);

  // Insert to conversation messages
  db.prepare(`
    INSERT INTO conversation_messages (id, conversation_id, temporal_node_id, role, content, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(msgId, state.id, temporalNode.id, role, content, tokens, now);

  // Update conversation last_message_at
  db.prepare(`UPDATE conversations SET last_message_at = ? WHERE id = ?`).run(now, state.id);

  // Update in-memory buffer
  state.buffer.push({ role, content });
  state.bufferTokenCount += tokens;
}

/**
 * Handle a full conversation turn (non-streaming).
 * Returns the assistant's response.
 */
export async function handleTurn(
  conversationId: string | undefined,
  userMessage: string
): Promise<{ response: string; conversationId: string }> {
  const state = getConversation(conversationId);

  // 1. Store user message
  storeMessage(state, 'user', userMessage);

  // 2. Auto-generate title from first message
  if (!state.title && state.turnCount === 0) {
    state.title = userMessage.slice(0, 50);
    const db = getDb();
    db.prepare(`UPDATE conversations SET title = ? WHERE id = ?`).run(state.title, state.id);
  }

  // 3. Check if summarization is needed
  if (shouldSummarize(state.bufferTokenCount)) {
    logger.info({ conversationId: state.id, tokens: state.bufferTokenCount }, 'Triggering buffer summarization');
    const { summary, count } = await summarizeBuffer(state.buffer);

    // Store the old summary
    const existingSummary = conversationSummaries.get(state.id);
    const combinedSummary = existingSummary ? `${existingSummary}\n\n${summary}` : summary;
    conversationSummaries.set(state.id, combinedSummary);

    // Remove summarized messages from buffer
    const removed = state.buffer.splice(0, count);
    state.bufferTokenCount = countMessagesTokens(state.buffer);

    // Store summary as temporal node
    temporalTree.insertLeaf('summary', summary);

    logger.info({ count, newTokens: state.bufferTokenCount }, 'Buffer summarized');
  }

  // 4. Recall memory
  const recallBudget = calculateRecallBudget(state.buffer);
  const recallResult = recall(userMessage, recallBudget);

  // 5. Assemble prompt
  const historySummary = conversationSummaries.get(state.id);
  const messages = assemblePrompt(state.buffer, recallResult, historySummary);

  // 6. Tool calling 循环
  const toolDefs = getToolDefinitions();
  let finalResponse = '';
  const MAX_TOOL_ITERATIONS = 5;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const result = await chatCompletionFull(messages, {
      tools: toolDefs,
      toolChoice: 'auto',
    });

    if (result.toolCalls && result.toolCalls.length > 0) {
      // 1. 将 assistant 消息（含 tool_calls）加入 messages
      messages.push({
        role: 'assistant' as const,
        content: result.content,
        tool_calls: result.toolCalls,
      });

      // 2. 执行每个工具，将结果加入 messages
      for (const toolCall of result.toolCalls) {
        // 只处理 function 类型的 tool call
        if (toolCall.type !== 'function') continue;

        let toolResult: string;
        try {
          const args = JSON.parse(toolCall.function.arguments);
          toolResult = await executeTool(toolCall.function.name, args);
        } catch (err) {
          toolResult = `工具调用失败: ${err instanceof Error ? err.message : String(err)}`;
        }
        messages.push({
          role: 'tool' as const,
          tool_call_id: toolCall.id,
          content: toolResult,
        });
      }

      // 继续循环，让 LLM 处理工具结果
      continue;
    }

    // 没有 tool_calls，取最终响应
    finalResponse = result.content || '';
    break;
  }

  // 7. Store assistant response
  storeMessage(state, 'assistant', finalResponse);
  state.turnCount++;

  // 8. Realtime knowledge extraction (fire-and-forget, does not block response)
  extractKnowledgeImmediate(state.id).catch((err) => {
    logger.warn({ err, conversationId: state.id }, 'Realtime knowledge extraction failed');
  });

  return { response: finalResponse, conversationId: state.id };
}

/**
 * Handle a streaming conversation turn.
 * Yields text chunks and stores the complete response at the end.
 */
export async function* handleTurnStream(
  conversationId: string | undefined,
  userMessage: string
): AsyncIterable<{ chunk?: string; conversationId: string; done?: boolean }> {
  const state = getConversation(conversationId);

  // 1. Store user message
  storeMessage(state, 'user', userMessage);

  // 2. Auto-generate title
  if (!state.title && state.turnCount === 0) {
    state.title = userMessage.slice(0, 50);
    const db = getDb();
    db.prepare(`UPDATE conversations SET title = ? WHERE id = ?`).run(state.title, state.id);
  }

  // 3. Check summarization
  if (shouldSummarize(state.bufferTokenCount)) {
    logger.info({ conversationId: state.id }, 'Triggering buffer summarization');
    const { summary, count } = await summarizeBuffer(state.buffer);
    const existingSummary = conversationSummaries.get(state.id);
    const combinedSummary = existingSummary ? `${existingSummary}\n\n${summary}` : summary;
    conversationSummaries.set(state.id, combinedSummary);
    state.buffer.splice(0, count);
    state.bufferTokenCount = countMessagesTokens(state.buffer);
    temporalTree.insertLeaf('summary', summary);
  }

  // 4. Recall
  const recallBudget = calculateRecallBudget(state.buffer);
  const recallResult = recall(userMessage, recallBudget);

  // 5. Assemble prompt
  const historySummary = conversationSummaries.get(state.id);
  const messages = assemblePrompt(state.buffer, recallResult, historySummary);

  // 6. Tool calling 循环（非流式）
  const toolDefs = getToolDefinitions();
  const MAX_TOOL_ITERATIONS = 5;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const result = await chatCompletionFull(messages, {
      tools: toolDefs,
      toolChoice: 'auto',
    });

    if (result.toolCalls && result.toolCalls.length > 0) {
      // 添加 assistant + tool 消息
      messages.push({
        role: 'assistant' as const,
        content: result.content,
        tool_calls: result.toolCalls,
      });
      for (const toolCall of result.toolCalls) {
        // 只处理 function 类型的 tool call
        if (toolCall.type !== 'function') continue;

        let toolResult: string;
        try {
          const args = JSON.parse(toolCall.function.arguments);
          toolResult = await executeTool(toolCall.function.name, args);
        } catch (err) {
          toolResult = `工具调用失败: ${err instanceof Error ? err.message : String(err)}`;
        }
        messages.push({
          role: 'tool' as const,
          tool_call_id: toolCall.id,
          content: toolResult,
        });
      }
      continue;
    }

    // 没有更多 tool_calls，跳出循环
    break;
  }

  // 7. 最后一次调用：流式输出最终响应
  let fullResponse = '';
  for await (const chunk of streamChatCompletion(messages)) {
    fullResponse += chunk;
    yield { chunk, conversationId: state.id };
  }

  // 8. Store response
  storeMessage(state, 'assistant', fullResponse);
  state.turnCount++;

  // 9. Realtime knowledge extraction (fire-and-forget, does not block response)
  extractKnowledgeImmediate(state.id).catch((err) => {
    logger.warn({ err, conversationId: state.id }, 'Realtime knowledge extraction failed');
  });

  yield { conversationId: state.id, done: true };
}

/**
 * Enqueue a background task to extract knowledge from recent conversation.
 */
function enqueueKnowledgeExtraction(conversationId: string): void {
  const db = getDb();
  const id = ulid();
  const now = nowISO();
  db.prepare(`
    INSERT INTO background_tasks (id, task_type, status, payload, created_at)
    VALUES (?, 'knowledge_extract', 'pending', ?, ?)
  `).run(id, JSON.stringify({ conversationId }), now);
  logger.info({ conversationId }, 'Knowledge extraction task enqueued');
}

/**
 * List all conversations.
 */
export function listConversations(): { id: string; title: string; createdAt: string; lastMessageAt: string }[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT id, title, created_at, last_message_at FROM conversations ORDER BY last_message_at DESC`)
    .all() as { id: string; title: string; created_at: string; last_message_at: string }[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    lastMessageAt: r.last_message_at,
  }));
}

/**
 * Get messages for a conversation.
 */
export function getConversationMessages(
  conversationId: string
): { role: string; content: string; createdAt: string }[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT role, content, created_at FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC`
    )
    .all(conversationId) as { role: string; content: string; created_at: string }[];
  return rows.map((r) => ({
    role: r.role,
    content: r.content,
    createdAt: r.created_at,
  }));
}

/**
 * Delete a conversation and its messages.
 */
export function deleteConversation(conversationId: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM conversation_messages WHERE conversation_id = ?`).run(conversationId);
  db.prepare(`DELETE FROM conversations WHERE id = ?`).run(conversationId);
  conversations.delete(conversationId);
  conversationSummaries.delete(conversationId);
}
