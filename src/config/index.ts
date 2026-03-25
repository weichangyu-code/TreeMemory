import dotenv from 'dotenv';

dotenv.config();

export interface AppConfig {
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  maxContextTokens: number;
  summarizeThresholdRatio: number;
  dbPath: string;
  httpPort: number;
  backgroundIntervalMs: number;
  activityDecayRate: number;
  activityBoost: number;
}

export const config: AppConfig = {
  llmBaseUrl: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
  llmApiKey: process.env.LLM_API_KEY || '',
  llmModel: process.env.LLM_MODEL || 'gpt-4o',
  maxContextTokens: parseInt(process.env.MAX_CONTEXT_TOKENS || '8192', 10),
  summarizeThresholdRatio: parseFloat(process.env.SUMMARIZE_THRESHOLD_RATIO || '0.75'),
  dbPath: process.env.DB_PATH || './treememory.db',
  httpPort: parseInt(process.env.HTTP_PORT || '3000', 10),
  backgroundIntervalMs: parseInt(process.env.BACKGROUND_INTERVAL_MS || '60000', 10),
  activityDecayRate: parseFloat(process.env.ACTIVITY_DECAY_RATE || '0.95'),
  activityBoost: parseFloat(process.env.ACTIVITY_BOOST || '1.0'),
};
