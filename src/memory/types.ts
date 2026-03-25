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
