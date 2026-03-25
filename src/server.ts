import Fastify from 'fastify';
import { ulid } from 'ulid';
import { config } from './config/index.js';
import {
  handleTurn,
  handleTurnStream,
  listConversations,
  getConversationMessages,
  deleteConversation,
} from './engine/conversation.js';
import * as knowledgeTree from './memory/knowledge-tree.js';
import * as temporalTree from './memory/temporal-tree.js';
import { logger } from './utils/logger.js';

export async function startServer(): Promise<void> {
  const app = Fastify({ logger: false });

  // OpenAI-compatible chat completion
  app.post('/v1/chat/completions', async (request, reply) => {
    const body = request.body as {
      messages?: { role: string; content: string }[];
      model?: string;
      stream?: boolean;
      conversation_id?: string;
    };

    if (!body.messages || body.messages.length === 0) {
      return reply.status(400).send({ error: { message: 'messages is required' } });
    }

    const lastUserMessage = [...body.messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMessage) {
      return reply.status(400).send({ error: { message: 'No user message found' } });
    }

    const conversationId = body.conversation_id;

    if (body.stream) {
      // SSE streaming response
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const responseId = `chatcmpl-${ulid()}`;
      let resolvedConvId = conversationId;

      for await (const result of handleTurnStream(conversationId, lastUserMessage.content)) {
        if (!resolvedConvId) resolvedConvId = result.conversationId;

        if (result.chunk) {
          const data = {
            id: responseId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model || config.llmModel,
            conversation_id: resolvedConvId,
            choices: [
              {
                index: 0,
                delta: { content: result.chunk },
                finish_reason: null,
              },
            ],
          };
          reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
        }

        if (result.done) {
          const doneData = {
            id: responseId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: body.model || config.llmModel,
            conversation_id: resolvedConvId,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          };
          reply.raw.write(`data: ${JSON.stringify(doneData)}\n\n`);
          reply.raw.write('data: [DONE]\n\n');
        }
      }

      reply.raw.end();
      return;
    }

    // Non-streaming response
    const { response, conversationId: convId } = await handleTurn(conversationId, lastUserMessage.content);
    return {
      id: `chatcmpl-${ulid()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || config.llmModel,
      conversation_id: convId,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: response },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };
  });

  // Memory endpoints
  app.get('/v1/memory/temporal', async (request) => {
    const query = request.query as { from?: string; to?: string; level?: string };
    if (query.from && query.to) {
      return temporalTree.getByTimeRange(query.from, query.to);
    }
    return temporalTree.getRecentLeaves(50);
  });

  app.get('/v1/memory/knowledge', async (request) => {
    const query = request.query as { path?: string; q?: string };
    if (query.q) {
      return knowledgeTree.search(query.q, 20);
    }
    if (query.path) {
      return knowledgeTree.findByPath(query.path);
    }
    return knowledgeTree.getAllNodes();
  });

  app.post('/v1/memory/knowledge', async (request) => {
    const body = request.body as { path: string[]; content: string };
    if (!body.path || !body.content) {
      return { error: 'path and content are required' };
    }
    return knowledgeTree.upsertPath(body.path, body.content);
  });

  // Conversation endpoints
  app.get('/v1/conversations', async () => {
    return listConversations();
  });

  app.get('/v1/conversations/:id', async (request) => {
    const { id } = request.params as { id: string };
    return getConversationMessages(id);
  });

  app.delete('/v1/conversations/:id', async (request) => {
    const { id } = request.params as { id: string };
    deleteConversation(id);
    return { success: true };
  });

  // Health check
  app.get('/health', async () => ({ status: 'ok' }));

  await app.listen({ port: config.httpPort, host: '0.0.0.0' });
  logger.info({ port: config.httpPort }, 'TreeMemory HTTP server started');
  console.log(`🚀 TreeMemory server running at http://localhost:${config.httpPort}`);
  console.log(`   POST /v1/chat/completions - OpenAI兼容聊天接口`);
  console.log(`   GET  /v1/memory/knowledge - 查看知识树`);
  console.log(`   GET  /v1/memory/temporal  - 查看时间树`);
}
