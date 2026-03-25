import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';

vi.mock('../../src/config/index.js', () => ({
  config: {
    llmBaseUrl: 'http://localhost:11434/v1',
    llmApiKey: 'test',
    llmModel: 'test',
    maxContextTokens: 8192,
    summarizeThresholdRatio: 0.75,
    dbPath: ':memory:',
    httpPort: 3000,
    backgroundIntervalMs: 60000,
    activityDecayRate: 0.95,
    activityBoost: 1.0,
  },
}));

describe('Context Manager', () => {
  it('should detect when summarization is needed', async () => {
    const { shouldSummarize } = await import('../../src/engine/context-manager.js');

    // Below threshold (75% of 8192 = 6144)
    expect(shouldSummarize(3000)).toBe(false);
    expect(shouldSummarize(6000)).toBe(false);

    // Above threshold
    expect(shouldSummarize(6200)).toBe(true);
    expect(shouldSummarize(8000)).toBe(true);
  });

  it('should calculate recall budget correctly', async () => {
    const { calculateRecallBudget } = await import('../../src/engine/context-manager.js');

    const budget = calculateRecallBudget([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]);

    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThan(8192);
  });
});
