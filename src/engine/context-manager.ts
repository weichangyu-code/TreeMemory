import { config } from '../config/index.js';
import { chatCompletion } from '../llm/client.js';
import { countTokens, countMessagesTokens } from '../llm/tokenizer.js';
import * as knowledgeTree from '../memory/knowledge-tree.js';
import * as temporalTree from '../memory/temporal-tree.js';
import { recall } from '../memory/recall.js';
import { CHAT_SYSTEM_PROMPT, BUFFER_SUMMARY_PROMPT } from '../prompts/index.js';
import type { ChatMessage } from '../llm/types.js';
import type { RecallResult, KnowledgeNode, TemporalNode } from '../memory/types.js';

// Token 预算上限
const TREE_OVERVIEW_TOKEN_LIMIT = 300;
const TOP_ACTIVE_KNOWLEDGE_TOKEN_LIMIT = 500;
const RECENT_SUMMARIES_TOKEN_LIMIT = 500;

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
 * 1. System message (base prompt + profile context + tree overview + active knowledge + knowledge context)
 * 2. Recent chat summaries (from temporal tree)
 * 3. Summary of older history (if any from recall)
 * 4. Buffer summary (from inline summarization)
 * 5. Recent conversation messages
 * 6. Current user message (already in buffer)
 */
export function assemblePrompt(
  buffer: ChatMessage[],
  recallResult: RecallResult,
  historySummary?: string
): ChatMessage[] {
  const messages: ChatMessage[] = [];

  // 1. System message with profile and knowledge context
  let systemContent = CHAT_SYSTEM_PROMPT;

  // 注入基本信息（Bot名字、主人名字等）
  const profiles = knowledgeTree.getAllProfiles();
  if (profiles.length > 0) {
    const profileLines = profiles.map((p) => `- ${p.key}: ${p.value}`);
    systemContent += `\n\n## 基本信息\n${profileLines.join('\n')}`;
  }

  // 注入知识树结构概览（新增）
  const treeOverview = knowledgeTree.getTreeOverview(3);
  if (treeOverview) {
    // 截断以控制 token 数量
    const truncatedOverview = truncateToTokenLimit(treeOverview, TREE_OVERVIEW_TOKEN_LIMIT);
    if (truncatedOverview) {
      systemContent += `\n\n## 你的知识结构\n${truncatedOverview}`;
    }
  }

  // 注入高活跃知识（新增）
  const topActiveKnowledge = knowledgeTree.getTopActiveKnowledge(10);
  if (topActiveKnowledge.length > 0) {
    // 格式化高活跃知识，使用简化格式
    const activeKnowledgeText = formatActiveKnowledge(topActiveKnowledge, TOP_ACTIVE_KNOWLEDGE_TOKEN_LIMIT);
    if (activeKnowledgeText) {
      systemContent += `\n\n## 近期重要记忆\n${activeKnowledgeText}`;
    }
  }

  // 注入知识上下文（已有）
  const knowledgeContext = knowledgeTree.toContextString(recallResult.knowledgeContext);
  if (knowledgeContext) {
    systemContent += '\n\n' + knowledgeContext;
  }

  // 注入最近聊天摘要（新增）
  const recentSummaries = temporalTree.getRecentSummaries(5);
  if (recentSummaries.length > 0) {
    const summariesText = formatRecentSummaries(recentSummaries, RECENT_SUMMARIES_TOKEN_LIMIT);
    if (summariesText) {
      systemContent += `\n\n## 最近的聊天总结\n${summariesText}`;
    }
  }

  messages.push({ role: 'system', content: systemContent });

  // 2. Historical summaries from temporal tree (from recall, level > 0)
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
 * 截断文本以控制 token 数量
 */
function truncateToTokenLimit(text: string, tokenLimit: number): string {
  const tokens = countTokens(text);
  if (tokens <= tokenLimit) return text;

  // 按行截断
  const lines = text.split('\n');
  let result = '';
  let currentTokens = 0;

  for (const line of lines) {
    const lineTokens = countTokens(line + '\n');
    if (currentTokens + lineTokens > tokenLimit) {
      // 添加省略标记
      if (result) {
        result += '\n...';
      }
      break;
    }
    result += (result ? '\n' : '') + line;
    currentTokens += lineTokens;
  }

  return result;
}

/**
 * 格式化高活跃知识，并控制 token 数量
 */
function formatActiveKnowledge(nodes: KnowledgeNode[], tokenLimit: number): string {
  const lines: string[] = [];
  let currentTokens = 0;

  for (const node of nodes) {
    // 简化路径：去掉 Root/ 前缀
    const simplePath = node.path.replace(/^Root\//, '');
    const line = `- [${simplePath}] ${node.content}`;
    const lineTokens = countTokens(line + '\n');

    if (currentTokens + lineTokens > tokenLimit) break;
    lines.push(line);
    currentTokens += lineTokens;
  }

  return lines.join('\n');
}

/**
 * 格式化最近摘要，并控制 token 数量
 */
function formatRecentSummaries(summaries: TemporalNode[], tokenLimit: number): string {
  const lines: string[] = [];
  let currentTokens = 0;

  for (const summary of summaries) {
    // 格式：[时间范围] 内容
    const timeRange = `${summary.timeStart.slice(0, 16)} ~ ${summary.timeEnd.slice(0, 16)}`;
    const line = `[${timeRange}] ${summary.content}`;
    const lineTokens = countTokens(line + '\n');

    if (currentTokens + lineTokens > tokenLimit) break;
    lines.push(line);
    currentTokens += lineTokens;
  }

  return lines.join('\n');
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
