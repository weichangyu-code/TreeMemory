import { ulid } from 'ulid';
import { getDb } from '../db/connection.js';
import { chatCompletion } from '../llm/client.js';
import * as knowledgeTree from '../memory/knowledge-tree.js';
import { nowISO } from '../utils/time.js';
import { logger } from '../utils/logger.js';

interface ExtractedFact {
  path: string[];
  content: string;
}

const EXTRACTION_PROMPT = `你是一个信息提取助手。请从以下对话中提取用户的相关事实信息。

提取规则：
1. 提取用户的个人信息（姓名、称呼、身份等）
2. 提取工作相关信息（公司、项目、技术栈等）
3. 提取偏好和习惯
4. 提取重要的决策和结论
5. 不要提取临时性的、无长期价值的信息

以JSON数组格式返回，每个元素包含path（路径数组）和content（内容字符串）：
[
  { "path": ["个人信息", "姓名"], "content": "小魏" },
  { "path": ["工作", "公司"], "content": "杭州智诺" }
]

如果没有有价值的信息，返回空数组: []

注意：只返回JSON，不要包含其他文字。`;

/**
 * Extract knowledge facts from a batch of conversation messages.
 */
async function extractFacts(messages: { role: string; content: string }[]): Promise<ExtractedFact[]> {
  const conversationText = messages
    .map((m) => `[${m.role}] ${m.content}`)
    .join('\n');

  const response = await chatCompletion([
    { role: 'system', content: EXTRACTION_PROMPT },
    { role: 'user', content: conversationText },
  ], { temperature: 0.1 });

  try {
    // Try to parse JSON from the response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const facts = JSON.parse(jsonMatch[0]) as ExtractedFact[];
    return facts.filter(
      (f) => Array.isArray(f.path) && f.path.length > 0 && typeof f.content === 'string' && f.content.length > 0
    );
  } catch {
    logger.warn({ response: response.slice(0, 200) }, 'Failed to parse knowledge extraction response');
    return [];
  }
}

/**
 * Process pending knowledge extraction tasks from the background_tasks queue.
 */
export async function runKnowledgeExtraction(): Promise<void> {
  const db = getDb();
  const now = nowISO();

  const tasks = db
    .prepare(
      `SELECT * FROM background_tasks WHERE status = 'pending' AND task_type = 'knowledge_extract' ORDER BY created_at ASC LIMIT 3`
    )
    .all() as { id: string; payload: string }[];

  for (const task of tasks) {
    db.prepare(`UPDATE background_tasks SET status = 'running' WHERE id = ?`).run(task.id);

    try {
      const payload = JSON.parse(task.payload) as { conversationId: string };

      // Get recent messages from this conversation
      const messages = db
        .prepare(
          `SELECT role, content FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 20`
        )
        .all(payload.conversationId) as { role: string; content: string }[];

      if (messages.length === 0) {
        db.prepare(`UPDATE background_tasks SET status = 'done', completed_at = ? WHERE id = ?`).run(now, task.id);
        continue;
      }

      messages.reverse(); // chronological order

      const facts = await extractFacts(messages);
      logger.info({ conversationId: payload.conversationId, factCount: facts.length }, 'Extracted knowledge facts');

      for (const fact of facts) {
        try {
          knowledgeTree.upsertPath(fact.path, fact.content);
          logger.info({ path: fact.path.join('/'), content: fact.content }, 'Knowledge fact stored');
        } catch (err) {
          logger.warn({ path: fact.path, err }, 'Failed to store knowledge fact');
        }
      }

      db.prepare(`UPDATE background_tasks SET status = 'done', completed_at = ? WHERE id = ?`).run(now, task.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      db.prepare(`UPDATE background_tasks SET status = 'failed', completed_at = ?, error = ? WHERE id = ?`).run(
        now,
        message,
        task.id
      );
      logger.error({ taskId: task.id, err }, 'Knowledge extraction task failed');
    }
  }
}
