export interface TreeNode {
  id: string;
  parentId: string | null;
  content: string;
  tokenCount: number;
  activityScore: number;
  lastActivatedAt: string;
  createdAt: string;
}

export interface TemporalNode extends TreeNode {
  level: 0 | 1 | 2; // 0=leaf, 1=hour, 2=day
  role: string; // user / assistant / system / command / summary
  timeStart: string;
  timeEnd: string;
  summarized: boolean;
  metadata: Record<string, unknown>;
}

export interface KnowledgeNode extends TreeNode {
  nodeType: 'category' | 'fact';
  name: string;
  path: string;
  sourceTemporalId: string | null;
  updatedAt: string;
}

export interface RecallResult {
  knowledgeContext: KnowledgeNode[];
  temporalContext: TemporalNode[];
  totalTokens: number;
}

// 基本信息的标准键
export type ProfileKey =
  | 'bot_name'       // Bot的名字
  | 'bot_persona'    // Bot的人设/性格描述
  | 'owner_name'     // 主人的名字/称呼
  | 'owner_info'     // 主人的基本描述
  | 'relationship'   // Bot和主人的关系描述
  | string;          // 允许自定义键

export interface ProfileEntry {
  key: ProfileKey;
  value: string;
  path: string;
}
