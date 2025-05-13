import { FastifyInstance } from 'fastify';
import { RoomManager } from '../utils/room';
import { CryptoManager } from '../utils/crypto';

export default async function historyRoutes(fastify: FastifyInstance) {
  // 获取历史消息
  fastify.get('/api/history', {
    schema: {
      querystring: {
        type: 'object',
        required: ['room'],
        properties: {
          room: { type: 'string' },
          from: { type: 'number' },
          to: { type: 'number' },
          limit: { type: 'number' }
        }
      }
    }
  }, async (request, reply) => {
    const { room, from, to, limit } = request.query as {
      room: string;
      from?: number;
      to?: number;
      limit?: number;
    };

    try {
      // 获取房间密钥
      const roomKey = await CryptoManager.getRoomKey(room);
      if (!roomKey) {
        return reply.code(404).send({
          error: '房间不存在或密钥已失效'
        });
      }

      // 获取消息
      const messages = await RoomManager.getMessages(room, from, to, limit);

      // 解密消息
      const decryptedMessages = await Promise.all(
        messages.map(async ({ id, message }) => ({
          id,
          ...(await CryptoManager.decryptMessage(message, roomKey))
        }))
      );

      return {
        messages: decryptedMessages
      };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({
        error: '获取历史消息失败'
      });
    }
  });

  // 获取最新消息
  fastify.get('/api/history/latest', {
    schema: {
      querystring: {
        type: 'object',
        required: ['room'],
        properties: {
          room: { type: 'string' },
          limit: { type: 'number' }
        }
      }
    }
  }, async (request, reply) => {
    const { room, limit } = request.query as {
      room: string;
      limit?: number;
    };

    try {
      // 获取房间密钥
      const roomKey = await CryptoManager.getRoomKey(room);
      if (!roomKey) {
        return reply.code(404).send({
          error: '房间不存在或密钥已失效'
        });
      }

      // 获取最新消息
      const messages = await RoomManager.getLatestMessages(room, limit);

      // 解密消息
      const decryptedMessages = await Promise.all(
        messages.map(async ({ id, message }) => ({
          id,
          ...(await CryptoManager.decryptMessage(message, roomKey))
        }))
      );

      return {
        messages: decryptedMessages
      };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({
        error: '获取最新消息失败'
      });
    }
  });
} 