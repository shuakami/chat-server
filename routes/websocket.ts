import { FastifyInstance } from 'fastify';
import { redis } from '../config/redis';
import {
  WebSocketConnection,
  ChatMessage,
  ConnectionParams,
  InternalEncryptedMessage
} from '../types/websocket';
import { parse } from 'querystring';
import { WebSocket } from 'ws';
import { WebsocketHandler } from '@fastify/websocket';
import { CryptoManager } from '../utils/crypto';
import { RoomManager } from '../utils/room';

/* -------------------- 常量 -------------------- */
const REDIS_ROOM_CHANNEL = 'chat:room:';
const HEARTBEAT_INTERVAL = 30_000;               // 30 秒
const JSON_STRINGIFY = JSON.stringify;

/* -------------------- 工具函数 -------------------- */
/** 仅在连接存活时发送，避免重复 readyState 判断 */
const safeSend = (ws: WebSocketConnection, payload: unknown) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(typeof payload === 'string' ? payload : JSON_STRINGIFY(payload));
  }
};

/** 构造统一错误消息 */
const buildError = (roomId: string, content: string): ChatMessage => ({
  type: 'error',
  roomId,
  userId: 'system',
  content,
  timestamp: Date.now()
});

/** 构造系统动作通知（delete / edit） */
const buildSystemAction = (
  roomId: string,
  action: 'delete' | 'edit',
  extra: Record<string, unknown>
): ChatMessage => ({
  type: 'system',
  roomId,
  userId: 'system',
  content: { action, ...extra },
  timestamp: Date.now()
});

/* -------------------- 主逻辑 -------------------- */
export default async function websocketRoutes(fastify: FastifyInstance) {
  const handler: WebsocketHandler = async (socket, request) => {
    const ws = socket as WebSocketConnection;
    const [, rawQuery = ''] = request.url.split('?');
    const params = parse(rawQuery) as unknown as ConnectionParams;

    /* ---------- 必要参数校验 ---------- */
    if (!params.roomId || !params.userId) {
      safeSend(ws, buildError('', '缺少必要参数：roomId 或 userId'));
      return ws.close();
    }

    ws.roomId = params.roomId;
    ws.userId = params.userId;
    ws.isAlive = true;

          /* ---------- 独立 Redis 订阅连接 ---------- */
      const subscriber = redis.duplicate();

      /* ---------- 确保房间密钥存在 ---------- */
      let roomKey = await CryptoManager.getRoomKey(params.roomId);
      if (!roomKey) {
        await CryptoManager.generateRoomKey(params.roomId);
        roomKey = await CryptoManager.getRoomKey(params.roomId);
      }
      if (!roomKey) {
        console.error(`[${params.roomId}] 房间密钥生成失败`);
        safeSend(ws, buildError(params.roomId, '房间密钥生成失败'));
        await subscriber.disconnect();
        return ws.close();
      }

      const roomChannel = `${REDIS_ROOM_CHANNEL}${params.roomId}`;
      const joinTimestamp = Date.now();

      try {
        /* ---------- 订阅房间消息 ---------- */
        // 设置消息处理器
        subscriber.on('message', async (channel: string, message: string) => {
          try {
            const parsed = JSON.parse(message);
            
            // 跳过发送者自己的消息
            if (parsed?.userId === ws.userId) {
              return;
            }

            if (typeof parsed === 'object' && parsed !== null && 'encrypted' in parsed) {
              try {
                const decrypted = await CryptoManager.decryptMessage(
                  parsed as InternalEncryptedMessage,
                  roomKey
                );
                if (decrypted && typeof decrypted === 'object') {
                  safeSend(ws, decrypted);
                }
              } catch (err) {
                console.error(`[${params.roomId}] 消息解密失败:`, err);
              }
            } else {
              if (parsed && typeof parsed === 'object') {
                safeSend(ws, parsed);
              }
            }
          } catch (err) {
            console.error(`[${params.roomId}] 消息处理错误:`, err);
          }
        });

        // 执行订阅
        await subscriber.subscribe(roomChannel);

      /* ---------- 更新在线用户列表 ---------- */
      await RoomManager.addOnlineUser(params.roomId, params.userId);
      const onlineUsers = await RoomManager.getOnlineUsers(params.roomId);

      const onlineListMsg: ChatMessage = {
        type: 'onlineList',
        roomId: params.roomId,
        userId: 'system',
        content: JSON_STRINGIFY(onlineUsers),
        timestamp: Date.now()
      };
      safeSend(ws, onlineListMsg);
      await redis.publish(roomChannel, JSON_STRINGIFY(onlineListMsg));

      /* ---------- 广播加入消息 ---------- */
      const joinMsg: ChatMessage = {
        type: 'join',
        roomId: params.roomId,
        userId: params.userId,
        content: `用户 ${params.userId} 加入了房间`,
        timestamp: joinTimestamp
      };
      await redis.publish(roomChannel, JSON_STRINGIFY(joinMsg));

      /* ---------- 发送历史记录（限 100 条） ---------- */
      const history = await redis.xrevrange(
        roomChannel,
        '+',
        '-',
        'COUNT',
        100
      );
      if (history?.length) {
        const messages = (
          await Promise.all(
            history.map(async ([id, [, msg]]) => {
              try {
                const parsed = JSON.parse(msg);
                const target = parsed.encrypted
                  ? await CryptoManager.decryptMessage(
                      parsed as InternalEncryptedMessage,
                      roomKey
                    )
                  : parsed;

                if (
                  (target.timestamp ?? 0) >= joinTimestamp ||
                  (target.type !== 'join' && target.type !== 'leave')
                ) {
                  return { id, ...target };
                }
              } catch {
                /* 忽略破损记录 */
              }
              return null;
            })
          )
        ).filter(Boolean);

        if (messages.length) {
          safeSend(ws, { type: 'history', messages });
        }
      }
    } catch (err) {
      console.error('处理用户加入时发生错误:', err);
      safeSend(ws, buildError(params.roomId, '处理用户加入失败'));
      await subscriber.disconnect();
      return ws.close();
    }

    /* ---------- WebSocket 消息处理 ---------- */
    ws.on('message', async (data) => {
      console.log(`[${params.roomId}] 收到用户消息:`, data.toString());
      try {
        const raw = JSON.parse(data.toString()) as ChatMessage & {
          action?: 'edit' | 'delete';
          messageId?: string;
        };
        console.log(`[${params.roomId}] 解析后的消息:`, raw);

        /* ===== 删除消息 ===== */
        if (raw.type === 'delete' || raw.action === 'delete') {
          if (!raw.messageId) {
            return safeSend(
              ws,
              await CryptoManager.encryptMessage(
                buildError(params.roomId, '消息ID不能为空'),
                roomKey
              )
            );
          }

          const success = await RoomManager.deleteMessage(
            params.roomId,
            raw.messageId,
            ws.userId
          );
          if (!success) {
            return safeSend(
              ws,
              await CryptoManager.encryptMessage(
                buildError(params.roomId, '删除消息失败'),
                roomKey
              )
            );
          }

          // 发送删除通知给所有用户
          const deleteNotice = buildSystemAction(params.roomId, 'delete', {
            messageId: raw.messageId
          });

          const encryptedNotice = await CryptoManager.encryptMessage(
            deleteNotice,
            roomKey
          );
          await redis.publish(roomChannel, JSON_STRINGIFY(encryptedNotice));

          // 发送确认给删除者
          safeSend(ws, deleteNotice);
          return;
        }

        /* ===== 编辑消息 ===== */
        if (raw.type === 'edit' || raw.action === 'edit') {
          if (!raw.messageId || !raw.content) {
            return safeSend(
              ws,
              await CryptoManager.encryptMessage(
                buildError(params.roomId, '消息ID和内容不能为空'),
                roomKey
              )
            );
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

          const encryptedNewMsg = await CryptoManager.encryptMessage(
            newMsg,
            roomKey
          );
          const success = await RoomManager.editMessage(
            params.roomId,
            raw.messageId,
            ws.userId,
            encryptedNewMsg
          );

          if (!success) {
            return safeSend(
              ws,
              await CryptoManager.encryptMessage(
                buildError(params.roomId, '修改消息失败'),
                roomKey
              )
            );
          }

          // 发送编辑通知给所有用户
          const updateNotice = buildSystemAction(params.roomId, 'edit', {
            messageId: raw.messageId,
            newMessage: {
              content: raw.content,
              timestamp: Date.now(),
              userId: ws.userId,
              fileMeta: raw.fileMeta
            }
          });

          const encryptedNotice = await CryptoManager.encryptMessage(
            updateNotice,
            roomKey
          );
          await redis.publish(roomChannel, JSON_STRINGIFY(encryptedNotice));

          // 发送确认给编辑者
          safeSend(ws, updateNotice);
          return;
        }

        /* ===== 普通消息 ===== */
        if (raw.type === 'message' || (!raw.type && !raw.action)) {
          console.log(`[${params.roomId}] 处理普通消息`);
          if (!raw.content) {
            console.log(`[${params.roomId}] 消息内容为空，终止处理`);
            return safeSend(
              ws,
              await CryptoManager.encryptMessage(
                buildError(params.roomId, '消息内容不能为空'),
                roomKey
              )
            );
          }

          const chatMsg: ChatMessage = {
            type: 'message',
            roomId: params.roomId,
            userId: ws.userId,
            content: raw.content,
            timestamp: Date.now(),
            fileMeta: raw.fileMeta
          };
          console.log(`[${params.roomId}] 构造的聊天消息:`, chatMsg);

          // 先加密消息
          console.log(`[${params.roomId}] 开始加密消息`);
          const encrypted = await CryptoManager.encryptMessage(
            chatMsg,
            roomKey
          );
          console.log(`[${params.roomId}] 消息加密完成`);
          const messageStr = JSON_STRINGIFY(encrypted);

          // 存储加密消息并获取ID
          console.log(`[${params.roomId}] 准备存储消息到Redis Stream`);
          const messageId = await redis.xadd(
            roomChannel,
            '*',
            'message',
            messageStr
          );
          console.log(`[${params.roomId}] 消息存储完成，ID:`, messageId);

          if (messageId) {
            // 构造带ID的消息
            const messageWithId = {
              ...chatMsg,
              messageId
            };

            // 加密带ID的消息
            const encryptedWithId = await CryptoManager.encryptMessage(
              messageWithId,
              roomKey
            );
            const messageStrWithId = JSON_STRINGIFY(encryptedWithId);

            // 广播带ID的加密消息
            const publishResult = await redis.publish(roomChannel, messageStrWithId);

            // 发送未加密的确认消息给发送者
            safeSend(ws, messageWithId);
          }
          return;
        }
      } catch {
        safeSend(
          ws,
          await CryptoManager.encryptMessage(
            buildError(params.roomId, '消息格式错误'),
            roomKey
          )
        );
      }
    });

    /* ---------- 心跳检测 ---------- */
    const pingInterval = setInterval(() => {
      if (!ws.isAlive) {
        clearInterval(pingInterval);
        ws.terminate(); // 强制关闭
        return;
      }
      ws.isAlive = false;
      ws.ping();
    }, HEARTBEAT_INTERVAL);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    /* ---------- 错误 & 关闭处理 ---------- */
    const cleanUp = async () => {
      clearInterval(pingInterval);
      try {
        await subscriber.unsubscribe(roomChannel);
      } finally {
        await subscriber.disconnect();
      }
    };

    ws.on('error', async (error) => {
      console.error('WebSocket error:', error);
      await cleanUp();
      ws.terminate();
    });

    ws.on('close', async () => {
      console.log(`用户 ${params.userId} 断开连接`);
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
        const onlineUsers = await RoomManager.getOnlineUsers(params.roomId);
        const onlineListMsg: ChatMessage = {
          type: 'onlineList',
          roomId: params.roomId,
          userId: 'system',
          content: JSON_STRINGIFY(onlineUsers),
          timestamp: Date.now()
        };
        await redis.publish(roomChannel, JSON_STRINGIFY(onlineListMsg));
      } catch (err) {
        console.error('处理用户离开时发生错误:', err);
      }
    });
  };

  /* ---------- 路由注册 ---------- */
  fastify.get('/ws', { websocket: true }, handler);
}
