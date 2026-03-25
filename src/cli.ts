import readline from 'readline';
import { handleTurnStream } from './engine/conversation.js';
import * as knowledgeTree from './memory/knowledge-tree.js';
import * as temporalTree from './memory/temporal-tree.js';
import { getDb } from './db/connection.js';
import { logger } from './utils/logger.js';

export async function startCli(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let conversationId: string | undefined;

  console.log('=== TreeMemory AI 对话系统 ===');
  console.log('输入消息开始对话，输入 /help 查看命令列表\n');

  const prompt = () => {
    rl.question('TreeMemory> ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        prompt();
        return;
      }

      // Handle special commands
      if (trimmed.startsWith('/')) {
        await handleCommand(trimmed);
        prompt();
        return;
      }

      // Regular conversation
      try {
        process.stdout.write('\n🤖 ');
        for await (const result of handleTurnStream(conversationId, trimmed)) {
          if (result.chunk) {
            process.stdout.write(result.chunk);
          }
          if (!conversationId) {
            conversationId = result.conversationId;
          }
        }
        process.stdout.write('\n\n');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`\n❌ 错误: ${message}\n`);
      }

      prompt();
    });
  };

  async function handleCommand(cmd: string): Promise<void> {
    const parts = cmd.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    switch (command) {
      case '/help':
        console.log(`
可用命令:
  /memory          - 显示知识树
  /memory <path>   - 搜索知识（如 /memory 工作）
  /history         - 显示最近对话历史
  /stats           - 统计信息
  /new             - 开始新对话
  /recall <query>  - 测试记忆召回
  /add <path> <content> - 手动添加知识（如 /add 姓名 小魏）
  /quit            - 退出
`);
        break;

      case '/memory': {
        if (args) {
          const results = knowledgeTree.search(args, 20);
          if (results.length === 0) {
            console.log('\n未找到相关知识。\n');
          } else {
            console.log('\n' + knowledgeTree.toContextString(results) + '\n');
          }
        } else {
          const allNodes = knowledgeTree.getAllNodes();
          if (allNodes.length === 0) {
            console.log('\n知识树为空。\n');
          } else {
            console.log('\n📚 知识树:');
            for (const node of allNodes) {
              const depth = node.path.split('/').length - 1;
              const indent = '  '.repeat(depth);
              const icon = node.nodeType === 'category' ? '📁' : '📄';
              const content = node.content ? `: ${node.content.slice(0, 80)}` : '';
              console.log(`${indent}${icon} ${node.name}${content} (活跃度: ${node.activityScore.toFixed(1)})`);
            }
            console.log();
          }
        }
        break;
      }

      case '/history': {
        const leaves = temporalTree.getRecentLeaves(20);
        if (leaves.length === 0) {
          console.log('\n暂无对话历史。\n');
        } else {
          console.log('\n📜 最近对话:');
          for (const leaf of leaves) {
            const time = leaf.timeStart.slice(11, 19);
            const role = leaf.role === 'user' ? '👤' : leaf.role === 'assistant' ? '🤖' : '📋';
            console.log(`  [${time}] ${role} ${leaf.content.slice(0, 100)}${leaf.content.length > 100 ? '...' : ''}`);
          }
          console.log();
        }
        break;
      }

      case '/stats': {
        const db = getDb();
        const temporalCount = (db.prepare(`SELECT count(*) as cnt FROM temporal_nodes`).get() as { cnt: number }).cnt;
        const knowledgeCount = (db.prepare(`SELECT count(*) as cnt FROM knowledge_nodes`).get() as { cnt: number }).cnt;
        const convCount = (db.prepare(`SELECT count(*) as cnt FROM conversations`).get() as { cnt: number }).cnt;
        const leafCount = (db.prepare(`SELECT count(*) as cnt FROM temporal_nodes WHERE level = 0`).get() as { cnt: number }).cnt;
        const hourCount = (db.prepare(`SELECT count(*) as cnt FROM temporal_nodes WHERE level = 1`).get() as { cnt: number }).cnt;
        const dayCount = (db.prepare(`SELECT count(*) as cnt FROM temporal_nodes WHERE level = 2`).get() as { cnt: number }).cnt;

        console.log(`
📊 统计信息:
  会话数: ${convCount}
  时间树节点: ${temporalCount} (叶子: ${leafCount}, 小时摘要: ${hourCount}, 天摘要: ${dayCount})
  知识树节点: ${knowledgeCount}
  当前会话: ${conversationId || '无'}
`);
        break;
      }

      case '/new':
        conversationId = undefined;
        console.log('\n✨ 已开始新对话。\n');
        break;

      case '/recall': {
        if (!args) {
          console.log('\n用法: /recall <查询内容>\n');
          break;
        }
        const { recall } = await import('./memory/recall.js');
        const result = recall(args, 2000);
        console.log(`\n🔍 召回结果 (${result.totalTokens} tokens):`);
        if (result.knowledgeContext.length > 0) {
          console.log('\n知识:');
          for (const k of result.knowledgeContext) {
            console.log(`  📄 ${k.path}: ${k.content}`);
          }
        }
        if (result.temporalContext.length > 0) {
          console.log('\n时间记忆:');
          for (const t of result.temporalContext) {
            const level = t.level === 0 ? '叶子' : t.level === 1 ? '小时' : '天';
            console.log(`  [${level}] ${t.content.slice(0, 100)}`);
          }
        }
        console.log();
        break;
      }

      case '/add': {
        const match = args.match(/^(.+?)\s+(.+)$/);
        if (!match) {
          console.log('\n用法: /add <路径段1/路径段2> <内容>\n例如: /add 姓名 小魏\n例如: /add 工作/公司 杭州智诺\n');
          break;
        }
        const pathStr = match[1];
        const content = match[2];
        const pathSegments = pathStr.split('/').filter(Boolean);
        const node = knowledgeTree.upsertPath(pathSegments, content);
        console.log(`\n✅ 已添加知识: ${node.path} = ${content}\n`);
        break;
      }

      case '/quit':
      case '/exit':
        console.log('\n👋 再见！\n');
        rl.close();
        process.exit(0);
        break;

      default:
        console.log(`\n未知命令: ${command}，输入 /help 查看帮助。\n`);
    }
  }

  prompt();
}
