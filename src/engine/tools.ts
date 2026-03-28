import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { getDb } from '../db/connection.js';
import * as knowledgeTree from '../memory/knowledge-tree.js';
import * as temporalTree from '../memory/temporal-tree.js';

/**
 * Function tool definition with type=function
 */
interface FunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

/**
 * Tool handler interface
 */
interface ToolHandler {
  definition: FunctionTool;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

// ============================================================================
// Tool 1: memory_search - 搜索知识库
// ============================================================================
const memorySearchTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'memory_search',
      description: '在知识库中搜索相关信息。根据查询关键词返回最相关的知识节点。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索关键词或短语',
          },
          topK: {
            type: 'number',
            description: '返回结果数量，默认10',
          },
        },
        required: ['query'],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args.query as string;
    const topK = (args.topK as number) || 10;
    const results = knowledgeTree.search(query, topK);
    if (results.length === 0) {
      return '未找到相关知识。';
    }
    const lines = results.map((node) => {
      const score = node.activityScore.toFixed(2);
      return `- [${node.path}] ${node.content} (活跃度: ${score})`;
    });
    return `找到 ${results.length} 条相关知识：\n${lines.join('\n')}`;
  },
};

// ============================================================================
// Tool 2: memory_browse - 浏览知识树结构
// ============================================================================
const memoryBrowseTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'memory_browse',
      description: '浏览知识树的顶级结构或指定路径下的子节点。适合概览知识分类结构。如需深入查看某个节点的上下文（包括父节点和子节点详情），请使用 memory_navigate。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '要浏览的路径前缀，如 "Root/工作"。留空则显示顶级分类。',
          },
          depth: {
            type: 'number',
            description: '显示的层级深度，默认2',
          },
        },
        required: [],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const path = args.path as string | undefined;
    const maxDepth = (args.depth as number) || 2;

    if (!path || path === '' || path === 'Root') {
      // 获取顶级分类
      const roots = knowledgeTree.getRootChildren();
      if (roots.length === 0) {
        return '知识库为空。';
      }
      const lines = roots.map((node) => {
        const icon = node.nodeType === 'category' ? '📁' : '📄';
        return `${icon} ${node.name}${node.content ? `: ${node.content}` : ''}`;
      });
      return `知识库顶级分类：\n${lines.join('\n')}`;
    }

    // 查找指定路径下的节点
    const prefix = path.startsWith('Root/') ? path : `Root/${path}`;
    const nodes = knowledgeTree.findByPath(prefix);
    if (nodes.length === 0) {
      return `路径 "${path}" 下没有找到节点。`;
    }

    // 计算基准深度
    const baseDepth = prefix.split('/').length;

    // 按深度过滤并格式化
    const filteredNodes = nodes.filter((node) => {
      const nodeDepth = node.path.split('/').length;
      return nodeDepth - baseDepth <= maxDepth;
    });

    const lines = filteredNodes.map((node) => {
      const depth = node.path.split('/').length - baseDepth;
      const indent = '  '.repeat(depth);
      const icon = node.nodeType === 'category' ? '📁' : '📄';
      return `${indent}${icon} ${node.name}${node.content ? `: ${node.content}` : ''}`;
    });

    return `路径 "${path}" 下的内容：\n${lines.join('\n')}`;
  },
};

// ============================================================================
// Tool 3: memory_write - 写入知识
// ============================================================================
const memoryWriteTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'memory_write',
      description: '将新知识保存到知识树中。路径表示知识的分类层级。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'array',
            items: { type: 'string' },
            description: '知识路径数组，如 ["工作", "公司"]',
          },
          content: {
            type: 'string',
            description: '知识内容，如 "杭州智诺"',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const pathSegments = args.path as string[];
    const content = args.content as string;

    if (!pathSegments || pathSegments.length === 0) {
      return '错误：路径不能为空。';
    }
    if (!content) {
      return '错误：内容不能为空。';
    }

    const node = knowledgeTree.upsertPath(pathSegments, content);
    return `已保存: ${node.path} = ${content}`;
  },
};

// ============================================================================
// Tool 4: memory_navigate - 导航知识树节点
// ============================================================================
const memoryNavigateTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'memory_navigate',
      description: '从知识树中的某个节点出发，查看其父节点和子节点。用于深入探索知识结构。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '节点的完整路径，如 "Root/工作/公司"。也可以只写 "工作/公司"，会自动加上 Root/ 前缀。',
          },
          node_id: {
            type: 'string',
            description: '节点ID（与path二选一）',
          },
          child_depth: {
            type: 'number',
            description: '向下展开的子节点层数，默认2',
          },
        },
        required: [],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const path = args.path as string | undefined;
    const nodeId = args.node_id as string | undefined;
    const childDepth = (args.child_depth as number) || 2;

    // 1. 通过 path 或 node_id 定位节点
    let targetNode: ReturnType<typeof knowledgeTree.getNodeByPath> = null;
    if (path) {
      const fullPath = path.startsWith('Root/') ? path : `Root/${path}`;
      targetNode = knowledgeTree.getNodeByPath(fullPath);
      if (!targetNode) {
        return `未找到路径为 "${fullPath}" 的节点。`;
      }
    } else if (nodeId) {
      const context = knowledgeTree.getNodeContext(nodeId, 0);
      if (!context) {
        return `未找到ID为 "${nodeId}" 的节点。`;
      }
      targetNode = context.node;
    } else {
      return '请提供 path 或 node_id 参数。';
    }

    // 2. 获取节点上下文
    const context = knowledgeTree.getNodeContext(targetNode.id, childDepth);
    if (!context) {
      return '无法获取节点上下文。';
    }

    // 3. 激活被访问的节点
    knowledgeTree.activate(targetNode.id);

    // 4. 格式化输出
    const lines: string[] = [];

    // 当前节点
    const score = context.node.activityScore.toFixed(2);
    const lastAccess = context.node.lastActivatedAt.slice(0, 10);
    lines.push(`📍 当前节点: ${context.node.path} (${context.node.nodeType})`);
    if (context.node.content) {
      lines.push(`   内容: ${context.node.content}`);
    }
    lines.push(`   活跃度: ${score} | 最后访问: ${lastAccess}`);

    // 父节点
    lines.push('');
    if (context.parent) {
      lines.push(`⬆️ 父节点: ${context.parent.path} (${context.parent.nodeType})`);
      if (context.parent.content) {
        lines.push(`   内容: ${context.parent.content}`);
      }
    } else {
      lines.push('⬆️ 父节点: 无（这是根节点）');
    }

    // 子节点
    lines.push('');
    if (context.children.length > 0) {
      lines.push(`⬇️ 子节点 (${childDepth}层, 共${context.children.length}个):`);

      // 按深度和路径组织子节点显示
      const baseDepth = context.node.path.split('/').length;
      for (const child of context.children) {
        const childDepthLevel = child.path.split('/').length - baseDepth;
        const indent = '  '.repeat(childDepthLevel);
        const icon = child.nodeType === 'category' ? '📁' : '📄';
        const contentPreview = child.content
          ? `: ${child.content.length > 50 ? child.content.slice(0, 50) + '...' : child.content}`
          : '';
        lines.push(`${indent}${icon} ${child.name}${contentPreview}`);
      }
    } else {
      lines.push('⬇️ 子节点: 无');
    }

    return lines.join('\n');
  },
};

// ============================================================================
// Tool 5: history_browse - 浏览历史时间树
// ============================================================================
const historyBrowseTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'history_browse',
      description: '浏览历史对话记录的时间树。支持按天查看小时摘要、按小时查看详细对话、按节点ID查看子节点。时间树的摘要由后台自动定期整理生成。',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: '日期，格式如 "2026-03-25"，查看该天的小时摘要',
          },
          hourKey: {
            type: 'string',
            description: '小时键，格式如 "2026-03-25T14"，查看该小时的详细对话',
          },
          nodeId: {
            type: 'string',
            description: '节点ID，查看该节点的所有子节点',
          },
        },
        required: [],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const date = args.date as string | undefined;
    const hourKey = args.hourKey as string | undefined;
    const nodeId = args.nodeId as string | undefined;
    const db = getDb();

    // 如果有 nodeId，查询该节点的子节点
    if (nodeId) {
      const children = db.prepare(`
        SELECT * FROM temporal_nodes
        WHERE parent_id = ?
        ORDER BY time_start ASC
      `).all(nodeId) as Record<string, unknown>[];

      if (children.length === 0) {
        return `节点 ${nodeId} 没有子节点。`;
      }

      const lines = children.map((row) => {
        const timeStart = (row.time_start as string).slice(0, 19);
        const role = row.role as string;
        const content = row.content as string;
        const preview = content.length > 100 ? content.slice(0, 100) + '...' : content;
        return `[${timeStart}] (${role}) ${preview}`;
      });
      return `节点 ${nodeId} 的子节点：\n${lines.join('\n')}`;
    }

    // 如果有 hourKey，查询该小时的叶节点（详细对话）
    if (hourKey) {
      const leaves = temporalTree.getLeavesByHour(hourKey);
      if (leaves.length === 0) {
        return `${hourKey} 时段没有对话记录。`;
      }

      const lines = leaves.map((node) => {
        const time = node.timeStart.slice(11, 19);
        const preview = node.content.length > 100 ? node.content.slice(0, 100) + '...' : node.content;
        return `[${time}] (${node.role}) ${preview}`;
      });
      return `${hourKey} 时段的对话：\n${lines.join('\n')}`;
    }

    // 如果有 date，查询该天的小时摘要
    if (date) {
      const hourSummaries = temporalTree.getHourSummariesByDay(date);
      if (hourSummaries.length === 0) {
        return `${date} 没有小时摘要。`;
      }

      const lines = hourSummaries.map((node) => {
        const hour = node.timeStart.slice(11, 13);
        const preview = node.content.length > 150 ? node.content.slice(0, 150) + '...' : node.content;
        return `[${hour}时] ${preview}`;
      });
      return `${date} 的小时摘要：\n${lines.join('\n')}`;
    }

    // 无参数：查询最近的天级摘要
    const daySummaries = db.prepare(`
      SELECT * FROM temporal_nodes
      WHERE level = 2
      ORDER BY time_start DESC
      LIMIT 20
    `).all() as Record<string, unknown>[];

    if (daySummaries.length === 0) {
      return '暂无历史摘要。可以指定 date 参数查看特定日期的详细记录。';
    }

    const lines = daySummaries.map((row) => {
      const date = (row.time_start as string).slice(0, 10);
      const content = row.content as string;
      const preview = content.length > 100 ? content.slice(0, 100) + '...' : content;
      return `[${date}] ${preview}`;
    });
    return `最近的历史摘要（按天）：\n${lines.join('\n')}`;
  },
};

// ============================================================================
// Tool 6: history_recall - 按时间范围回忆历史
// ============================================================================
const historyRecallTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'history_recall',
      description: '按时间范围查询历史对话记录。',
      parameters: {
        type: 'object',
        properties: {
          from: {
            type: 'string',
            description: '开始时间，ISO格式如 "2026-03-25T00:00:00.000Z" 或简写 "2026-03-25"',
          },
          to: {
            type: 'string',
            description: '结束时间，ISO格式如 "2026-03-25T23:59:59.999Z" 或简写 "2026-03-25"',
          },
        },
        required: ['from', 'to'],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    let from = args.from as string;
    let to = args.to as string;

    // 处理简写格式
    if (from.length === 10) {
      from = `${from}T00:00:00.000Z`;
    }
    if (to.length === 10) {
      to = `${to}T23:59:59.999Z`;
    }

    const nodes = temporalTree.getByTimeRange(from, to);
    if (nodes.length === 0) {
      return `在 ${from} 至 ${to} 期间没有找到记录。`;
    }

    // 按级别分组
    const level2 = nodes.filter((n) => n.level === 2);
    const level1 = nodes.filter((n) => n.level === 1);
    const level0 = nodes.filter((n) => n.level === 0);

    const lines: string[] = [];
    lines.push(`时间范围: ${from.slice(0, 10)} 至 ${to.slice(0, 10)}`);
    lines.push(`共找到: ${level2.length} 个天摘要, ${level1.length} 个小时摘要, ${level0.length} 条详细记录\n`);

    if (level2.length > 0) {
      lines.push('## 天摘要');
      for (const node of level2.slice(0, 5)) {
        const date = node.timeStart.slice(0, 10);
        lines.push(`[${date}] ${node.content}`);
      }
    }

    if (level1.length > 0 && level2.length === 0) {
      lines.push('## 小时摘要');
      for (const node of level1.slice(0, 10)) {
        const time = node.timeStart.slice(0, 16);
        const preview = node.content.length > 100 ? node.content.slice(0, 100) + '...' : node.content;
        lines.push(`[${time}] ${preview}`);
      }
    }

    if (level0.length > 0 && level1.length === 0 && level2.length === 0) {
      lines.push('## 详细对话');
      for (const node of level0.slice(0, 20)) {
        const time = node.timeStart.slice(11, 19);
        const preview = node.content.length > 80 ? node.content.slice(0, 80) + '...' : node.content;
        lines.push(`[${time}] (${node.role}) ${preview}`);
      }
    }

    return lines.join('\n');
  },
};

// ============================================================================
// Tool 7: get_current_time - 获取当前时间
// ============================================================================
const getCurrentTimeTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: '获取当前系统时间。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  async execute(_args: Record<string, unknown>): Promise<string> {
    const now = new Date();
    const iso = now.toISOString();

    // 中文星期
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const weekday = weekdays[now.getDay()];

    // 格式化中文时间
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');

    const readable = `${year}年${month}月${day}日 星期${weekday} ${hours}:${minutes}`;
    return `当前时间: ${iso}\n人类可读: ${readable}`;
  },
};

// ============================================================================
// Tool 8: profile_set - 设置基本信息
// ============================================================================
const profileSetTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'profile_set',
      description: '设置基本信息（如Bot名字、主人名字等核心身份信息）',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: '信息键名。预定义键：bot_name（Bot名字）、bot_persona（Bot人设）、owner_name（主人名字）、owner_info（主人简介）、relationship（关系描述）。也支持自定义键名。',
          },
          value: {
            type: 'string',
            description: '信息内容',
          },
        },
        required: ['key', 'value'],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const key = args.key as string;
    const value = args.value as string;

    if (!key) {
      return '错误：键名不能为空。';
    }
    if (!value) {
      return '错误：内容不能为空。';
    }

    const node = knowledgeTree.setProfile(key, value);
    return `已设置基本信息: ${key} = ${value}\n存储路径: ${node.path}`;
  },
};

// ============================================================================
// Tool 9: profile_get - 获取基本信息
// ============================================================================
const profileGetTool: ToolHandler = {
  definition: {
    type: 'function',
    function: {
      name: 'profile_get',
      description: '获取基本信息（如Bot名字、主人名字等）',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: '要查询的信息键名。留空可获取所有基本信息。',
          },
        },
        required: [],
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const key = args.key as string | undefined;

    if (key) {
      const value = knowledgeTree.getProfile(key);
      if (value === null) {
        return `未找到基本信息: ${key}`;
      }
      return `${key} = ${value}`;
    }

    // 获取所有基本信息
    const profiles = knowledgeTree.getAllProfiles();
    if (profiles.length === 0) {
      return '暂无基本信息。';
    }

    const lines = profiles.map((p) => `- ${p.key}: ${p.value}`);
    return `基本信息（共 ${profiles.length} 项）：\n${lines.join('\n')}`;
  },
};

// ============================================================================
// 工具注册和导出
// ============================================================================

const tools: ToolHandler[] = [
  memorySearchTool,
  memoryBrowseTool,
  memoryWriteTool,
  memoryNavigateTool,
  historyBrowseTool,
  historyRecallTool,
  getCurrentTimeTool,
  profileSetTool,
  profileGetTool,
];

const toolMap = new Map<string, ToolHandler>(
  tools.map((t) => [t.definition.function.name, t])
);

/**
 * Get all tool definitions for LLM.
 */
export function getToolDefinitions(): ChatCompletionTool[] {
  return tools.map((t) => t.definition) as ChatCompletionTool[];
}

/**
 * Execute a tool by name with given arguments.
 */
export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  const handler = toolMap.get(name);
  if (!handler) {
    return `未知工具: ${name}`;
  }
  try {
    return await handler.execute(args);
  } catch (err) {
    return `工具执行失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Get tool names list.
 */
export function getToolNames(): string[] {
  return tools.map((t) => t.definition.function.name);
}
