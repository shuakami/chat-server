/* ==============================================================
 * websocketRoutes.ts  —— 2025-05-15 增量智能缓存版 + 并行加速
 * ============================================================== */

import { FastifyInstance } from 'fastify';
import { WebsocketHandler } from '@fastify/websocket';
import { WebSocket } from 'ws';
import { parse } from 'querystring';
import { redis } from '../config/redis';
import {
  WebSocketConnection,
  ChatMessage,
  ConnectionParams,
  InternalEncryptedMessage
} from '../types/websocket';
import { CryptoManager } from '../utils/crypto';
import { RoomManager } from '../utils/room';
import { LRUCache } from '../utils/cache';   // ← 新增 LRU 缓存
import { sendPushNotification } from './push'; // <-- 导入推送函数

/* -------------------- 常量 -------------------- */
const REDIS_ROOM_CHANNEL  = 'chat:room:';
const HEARTBEAT_INTERVAL  = 30_000;
const HISTORY_LIMIT       = 100;
const DECRYPT_CONCURRENCY = 16;  // 增加并发处理数
const JSON_STRINGIFY      = JSON.stringify;

/* -------------------- 全局解密缓存 -------------------- */
const decryptCache = new LRUCache<string, ChatMessage>(50_000, 5 * 60_000);  // 默认 5 min TTL

/* -------------------- 工具函数 -------------------- */
const safeSend = (ws: WebSocketConnection, payload: unknown) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(typeof payload === 'string' ? payload : JSON_STRINGIFY(payload));
  }
};

const buildError = (roomId: string, content: string): ChatMessage => ({
  type: 'error',
  roomId,
  userId: 'system',
  content,
  timestamp: Date.now()
});

const buildSystemMsg = (
  roomId: string,
  action: string,
  extra: Record<string, unknown> = {}
): ChatMessage => ({
  type: 'system',
  roomId,
  userId: 'system',
  content: { action, ...extra },
  timestamp: Date.now()
});

const sendEncrypted = async (
  ws: WebSocketConnection,
  plain: ChatMessage,
  key: Buffer
) => safeSend(ws, await CryptoManager.encryptMessage(plain, key));

/**
 * 将对象序列化为缓存键
 *  - 加密消息：字段内容唯一，序列化即可当键
 *  - 非加密对象：直接返回 null → 跳过缓存
 */
const makeCacheKey = (obj: unknown): string | null => {
  return obj && typeof obj === 'object' && 'encrypted' in (obj as object)
    ? JSON_STRINGIFY(obj) // 性能足够且唯一
    : null;
};

/** 带缓存的解密 */
const decryptWithCache = async (
  encObj: InternalEncryptedMessage,
  key: Buffer
): Promise<ChatMessage> => {
  // 验证是否为加密消息
  if (!encObj?.encrypted || !encObj?.payload) {
      return encObj as unknown as ChatMessage;
  }
  
  const cacheKey = makeCacheKey(encObj);
  if (cacheKey) {
    const hit = decryptCache.get(cacheKey);
    if (hit) return hit;
  }
  const decrypted = await CryptoManager.decryptMessage(encObj, key);
  if (cacheKey) decryptCache.set(cacheKey, decrypted);
  return decrypted;
};

/** 并发 map（限流） */
async function mapWithConcurrency<T, R>(
  list: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  const executing: Promise<void>[] = [];

  for (let i = 0; i < list.length; i++) {
    const p = fn(list[i], i).then(r => void results.push(r));
    executing.push(p);
    p.finally(() => {
      const idx = executing.indexOf(p);
      if (idx >= 0) executing.splice(idx, 1);
    });
    if (executing.length >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
  return results;
}

/* -------------------- 路由实现 -------------------- */
export default async function websocketRoutes (fastify: FastifyInstance) {
  const handler: WebsocketHandler = async (socket, request) => {
    const ws = socket as WebSocketConnection;
    const [, rawQuery = ''] = request.url.split('?');
    const params = parse(rawQuery) as unknown as ConnectionParams;

    /* ---------- 校验参数 ---------- */
    if (!params.roomId || !params.userId) {
      safeSend(ws, buildError('', '缺少必要参数：roomId 或 userId'));
      return ws.close();
    }
    ws.roomId = params.roomId;
    ws.userId = params.userId;
    ws.isAlive = true;

    /* ---------- Redis 订阅 ---------- */
    const subscriber = redis.duplicate();
    const roomChannel   = `${REDIS_ROOM_CHANNEL}${params.roomId}`;
    const joinTimestamp = Date.now();

    /* ---------- 房间密钥 ---------- */
    let roomKey = await CryptoManager.getRoomKey(params.roomId);
    if (!roomKey) {
      await CryptoManager.generateRoomKey(params.roomId);
      roomKey = await CryptoManager.getRoomKey(params.roomId);
    }
    if (!roomKey) {
      safeSend(ws, buildError(params.roomId, '房间密钥生成失败'));
      await subscriber.disconnect();
      return ws.close();
    }

    /* ---------- 订阅广播 ---------- */
    subscriber.on('message', (_c, rawStr) => {
      setImmediate(async () => {
        try {
          const parsed = JSON.parse(rawStr);

          // 跳过发送者自己
          if (parsed?.userId === ws.userId) return;

          // 非加密消息直接发，加密消息用缓存解密
          const out =
            parsed && typeof parsed === 'object' && 'encrypted' in parsed
              ? await decryptWithCache(parsed as InternalEncryptedMessage, roomKey!)
              : (parsed as ChatMessage);

          if (out) safeSend(ws, out);
        } catch (err) {
          console.error('广播处理错误:', err);
        }
      });
    });
    await subscriber.subscribe(roomChannel);

    try {
      /* ---------- 在线列表 ---------- */
      await RoomManager.addOnlineUser(params.roomId, params.userId);
      const users = await RoomManager.getOnlineUsers(params.roomId);
      const onlineListMsg: ChatMessage = {
        type: 'onlineList',
        roomId: params.roomId,
        userId: 'system',
        content: JSON.stringify(users),
        timestamp: Date.now()
      };
      await redis.publish(roomChannel, JSON_STRINGIFY(onlineListMsg));

      /* ---------- 广播 join ---------- */
      const joinMsg: ChatMessage = {
        type: 'join',
        roomId: params.roomId,
        userId: params.userId,
        content: `用户 ${params.userId} 加入了房间`,
        timestamp: joinTimestamp
      };
      await redis.publish(roomChannel, JSON_STRINGIFY(joinMsg));

      /* ---------- 回放历史（带缓存） ---------- */
      const latestEncrypted = await RoomManager.getLatestMessages(params.roomId, HISTORY_LIMIT);
      if (latestEncrypted.length) {
        const history = (
          await mapWithConcurrency(
            latestEncrypted,
            DECRYPT_CONCURRENCY,
            async ({ id, message }) => {
              const dec = await decryptWithCache(message, roomKey!);
              if (
                (dec.timestamp ?? 0) < joinTimestamp
                  ? dec.type !== 'join' && dec.type !== 'leave'
                  : true
              ) {
                return { ...dec, id: dec.messageId || id };
              }
              return null;
            }
          )
        ).filter(Boolean);

        if (history.length) safeSend(ws, { type: 'history', messages: history });
      }
    } catch (err) {
      console.error('加入流程异常:', err);
      await sendEncrypted(ws, buildError(params.roomId, '处理加入失败'), roomKey!);
      await subscriber.disconnect();
      return ws.close();
    }

    /* =================== 消息处理 =================== */
    ws.on('message', async (data) => {
      try {
        const raw = JSON.parse(data.toString()) as ChatMessage & {
          action?: 'edit' | 'delete' | 'deleteAll';
          messageId?: string;
        };

        /* ----- 删除 ----- */
        if (raw.type === 'delete' || raw.action === 'delete') {
          if (!raw.messageId) {
            return sendEncrypted(ws, buildError(params.roomId, '消息 ID 不能为空'), roomKey!);
          }
          const ok = await RoomManager.deleteMessage(params.roomId, raw.messageId, ws.userId, roomKey!);
          if (!ok) {
            return sendEncrypted(ws, buildError(params.roomId, '删除失败'), roomKey!);
          }
          const notice = buildSystemMsg(params.roomId, 'delete', { messageId: raw.messageId });
          await redis.publish(roomChannel, JSON_STRINGIFY(await CryptoManager.encryptMessage(notice, roomKey!)));
          safeSend(ws, notice);
          return;
        }

        /* ----- 批量删除用户消息 ----- */
        if (raw.type === 'deleteAll') {
          const result = await RoomManager.deleteUserMessages(params.roomId, ws.userId, roomKey!);
          if (!result.success) {
            return sendEncrypted(ws, buildError(params.roomId, '批量删除失败'), roomKey!);
          }
          const notice = buildSystemMsg(params.roomId, 'deleteAll', { 
            userId: ws.userId,
            count: result.count 
          });
          await redis.publish(roomChannel, JSON_STRINGIFY(await CryptoManager.encryptMessage(notice, roomKey!)));
          return;
        }

        /* ----- 编辑 ----- */
        if (raw.type === 'edit' || raw.action === 'edit') {
          if (!raw.messageId || !raw.content) {
            return sendEncrypted(ws, buildError(params.roomId, '消息 ID 与内容不能为空'), roomKey!);
          }
          const newMsg: ChatMessage = {
            type: 'message',
            roomId: params.roomId,
            userId: ws.userId,
            content: raw.content,
            timestamp: Date.now(),
            fileMeta: raw.fileMeta,
            messageId: raw.messageId
          };
          const encrypted = await CryptoManager.encryptMessage(newMsg, roomKey!);
          const ok = await RoomManager.editMessage(params.roomId, raw.messageId, ws.userId, encrypted, roomKey!);
          if (!ok) {
            return sendEncrypted(ws, buildError(params.roomId, '修改失败'), roomKey!);
          }
          const notice = buildSystemMsg(params.roomId, 'edit', {
            messageId: raw.messageId,
            newMessage: { ...newMsg }
          });
          await redis.publish(roomChannel, JSON_STRINGIFY(await CryptoManager.encryptMessage(notice, roomKey!)));
          safeSend(ws, notice);
          return;
        }

        /* ----- 普通消息 ----- */
        if (raw.type === 'message' || (!raw.type && !raw.action)) {
          if (!raw.content) {
            return sendEncrypted(ws, buildError(params.roomId, '消息内容不能为空'), roomKey!);
          }
          const chatMsg: ChatMessage = {
            type: 'message',
            roomId: params.roomId,
            userId: ws.userId,
            content: raw.content,
            timestamp: Date.now(),
            fileMeta: raw.fileMeta
          };
          const encrypted = await CryptoManager.encryptMessage(chatMsg, roomKey!);
          const streamId  = await RoomManager.saveMessage(params.roomId, encrypted);
          if (!streamId) {
            return sendEncrypted(ws, buildError(params.roomId, '消息持久化失败'), roomKey!);
          }
          chatMsg.messageId = streamId;
          
          // 广播给房间内的所有 WebSocket 连接
          await redis.publish(roomChannel, JSON_STRINGIFY(await CryptoManager.encryptMessage(chatMsg, roomKey!)));
          
          // 给发送者回执（通常 WebSocket 客户端会处理自己发送的消息，或依赖于广播）
          safeSend(ws, chatMsg);

          // --- 开始离线推送逻辑 ---
          try {
            const allRoomMembers = await RoomManager.getRoomMembers(params.roomId);
            const onlineUsersInRoom = await RoomManager.getOnlineUsers(params.roomId);
            
            const offlineUsers = allRoomMembers.filter(memberId => !onlineUsersInRoom.includes(memberId) && memberId !== ws.userId);

            if (offlineUsers.length > 0) {
              fastify.log.info(`房间 [${params.roomId}] 有 ${offlineUsers.length} 个潜在离线用户需要推送。`);
              const pushPayload = {
                title: `房间 ${params.roomId} 有新消息来自 ${chatMsg.userId}`,
                body: typeof chatMsg.content === 'string' 
                        ? (chatMsg.content.length > 100 ? chatMsg.content.substring(0, 97) + '...' : chatMsg.content)
                        : '您收到一条新消息',
                data: {
                  roomId: params.roomId,
                  messageId: chatMsg.messageId,
                  senderId: chatMsg.userId
                }
              };
              for (const targetUserId of offlineUsers) {
                fastify.log.info(`尝试为用户 ${targetUserId} 在房间 ${params.roomId} 推送消息`);
                sendPushNotification(fastify, targetUserId, pushPayload, params.roomId);
              }
            }
          } catch (pushError) {
            fastify.log.error(`为房间 ${params.roomId} 处理离线推送时出错:`, pushError);
          }
          // --- 结束离线推送逻辑 ---
          return;
        }
      } catch (parseError) { // 更具体的 catch 变量名
        fastify.log.error('消息处理或解析错误:', parseError);
        await sendEncrypted(ws, buildError(params.roomId, '消息格式错误'), roomKey!);
      }
    });

    /* =================== 心跳检测 =================== */
    const pingInterval = setInterval(() => {
      if (!ws.isAlive) { clearInterval(pingInterval); ws.terminate(); return; }
      ws.isAlive = false; ws.ping();
    }, HEARTBEAT_INTERVAL);

    ws.on('pong', () => (ws.isAlive = true));

    /* =================== 关闭 / 错误 =================== */
    const cleanUp = async () => {
      clearInterval(pingInterval);
      try { await subscriber.unsubscribe(roomChannel); } finally { await subscriber.disconnect(); }
    };

    ws.on('error', async (e) => { console.error('WebSocket error:', e); await cleanUp(); ws.terminate(); });
    ws.on('close', async () => {
      await cleanUp();
      try {
        const leaveMsg: ChatMessage = {
          type: 'leave',
          roomId: params.roomId,
          userId: params.userId,
          content: `用户 ${params.userId} 离开了房间`,
          timestamp: Date.now()
        };
        await redis.publish(roomChannel, JSON_STRINGIFY(leaveMsg));

        await RoomManager.removeOnlineUser(params.roomId, params.userId);
        const users = await RoomManager.getOnlineUsers(params.roomId);
        const listMsg: ChatMessage = {
          type: 'onlineList',
          roomId: params.roomId,
          userId: 'system',
          content: JSON.stringify(users),
          timestamp: Date.now()
        };
        await redis.publish(roomChannel, JSON_STRINGIFY(listMsg));
      } catch (err) {
        console.error('处理离开事件时发生错误:', err);
      }
    });
  };

  /* ---------- 路由注册 ---------- */
  fastify.get('/ws', { websocket: true }, handler);
}
