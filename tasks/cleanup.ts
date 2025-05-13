import { RoomManager } from '../utils/room';
import { config } from '../config/env';
import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * 执行房间清理任务
 */
export async function cleanupTask(): Promise<void> {
  try {
    console.log('开始执行房间清理任务...');
    await RoomManager.cleanupInactiveRooms();
    console.log('房间清理任务完成');
  } catch (err) {
    console.error('房间清理任务失败:', err);
    throw err;
  }
}

// Vercel Cron处理函数
export default async function handler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (request.method !== 'POST') {
    return reply.status(405).send({ error: '方法不允许' });
  }

  try {
    await cleanupTask();
    return reply.status(200).send({ success: true });
  } catch (err) {
    console.error('Cron任务执行失败:', err);
    return reply.status(500).send({ error: '任务执行失败' });
  }
}

// 在非Vercel环境中使用node-cron
if (!process.env.VERCEL) {
  const cron = require('node-cron');
  cron.schedule('0 3 * * *', cleanupTask);
} 