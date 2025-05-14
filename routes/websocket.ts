import { FastifyInstance } from 'fastify';
import { redis, subscriber } from '../config/redis';
import { WebSocketConnection, ChatMessage, ConnectionParams, InternalEncryptedMessage } from '../types/websocket';
import { parse } from 'querystring';
import { WebSocket } from 'ws';
import { WebsocketHandler } from '@fastify/websocket';
import { CryptoManager } from '../utils/crypto';
import { RoomManager } from '../utils/room';

// Redis 频道前缀
const REDIS_ROOM_CHANNEL = 'chat:room:';

export default async function websocketRoutes(fastify: FastifyInstance) {
  const handler: WebsocketHandler = async (socket, request) => {
    const ws = socket as WebSocketConnection;
    const queryString = request.url.split('?')[1] || '';
    const params = parse(queryString) as unknown as ConnectionParams;

    // 验证必要参数
    if (!params.roomId || !params.userId) {
      ws.send(JSON.stringify({
        type: 'error',
        roomId: '',
        userId: 'system',
        content: '缺少必要参数：roomId 或 userId',
        timestamp: Date.now()
      }));
      ws.close();
      return;
    }

    // 设置连接属性
    ws.userId = params.userId;
    ws.roomId = params.roomId;
    ws.isAlive = true;

    // 确保房间有加密密钥
    let roomKey = await CryptoManager.getRoomKey(params.roomId);
    if (!roomKey) {
      await CryptoManager.generateRoomKey(params.roomId);
      roomKey = await CryptoManager.getRoomKey(params.roomId);
    }

    if (!roomKey) {
      ws.send(JSON.stringify({
        type: 'error',
        roomId: params.roomId,
        userId: 'system',
        content: '房间密钥生成失败',
        timestamp: Date.now()
      }));
      ws.close();
      return;
    }

    // 订阅房间频道
    const roomChannel = `${REDIS_ROOM_CHANNEL}${params.roomId}`;
    
    // 记录用户加入时间
    const joinTimestamp = Date.now();

    // 获取并更新在线用户列表
    const onlineUsers = await RoomManager.getOnlineUsers(params.roomId);
    const isFirstJoin = !onlineUsers.includes(params.userId);
    await RoomManager.addOnlineUser(params.roomId, params.userId);

    // 如果是首次加入，推送在线用户列表
    if (isFirstJoin) {
      const updatedOnlineUsers = await RoomManager.getOnlineUsers(params.roomId);
      const onlineListMessage: ChatMessage = {
        type: 'onlineList',
        roomId: params.roomId,
        userId: 'system',
        content: JSON.stringify(updatedOnlineUsers),
        timestamp: Date.now()
      };
      ws.send(JSON.stringify(onlineListMessage));
    }
    
    // 发送加入消息
    const joinMessage: ChatMessage = {
      type: 'join',
      roomId: params.roomId,
      userId: params.userId,
      content: `用户 ${params.userId} 加入了房间`,
      timestamp: joinTimestamp
    };

    await redis.publish(roomChannel, JSON.stringify(joinMessage));

    // 广播最新的在线用户列表
    const currentOnlineUsers = await RoomManager.getOnlineUsers(params.roomId);
    const onlineListMessage: ChatMessage = {
      type: 'onlineList',
      roomId: params.roomId,
      userId: 'system',
      content: JSON.stringify(currentOnlineUsers),
      timestamp: Date.now()
    };
    await redis.publish(roomChannel, JSON.stringify(onlineListMessage));

    // 发送历史消息（只发送用户加入时间点之后的消息，且过滤掉进出记录）
    const history = await redis.xrevrange(roomChannel, '+', '-');
    if (history && history.length > 0) {
      const messages = await Promise.all(
        history.map(async ([id, fields]) => {
          try {
            const messageStr = fields[1];
            if (typeof messageStr === 'string') {
              const parsedMessage = JSON.parse(messageStr);
              
              // 如果是加密消息，先解密
              if (parsedMessage.encrypted) {
                const decryptedMessage = await CryptoManager.decryptMessage(parsedMessage as InternalEncryptedMessage, roomKey!);
                // 只返回用户加入时间点之后的消息，且过滤掉进出记录
                if (decryptedMessage.timestamp >= joinTimestamp || 
                    (decryptedMessage.type !== 'join' && decryptedMessage.type !== 'leave')) {
                  return {
                    id,
                    ...decryptedMessage
                  };
                }
              } else {
                // 未加密消息直接返回
                if (parsedMessage.timestamp >= joinTimestamp || 
                    (parsedMessage.type !== 'join' && parsedMessage.type !== 'leave')) {
                  return {
                    id,
                    ...parsedMessage
                  };
                }
              }
            }
            return null;
          } catch (e) {
            return null;
          }
        })
      ).then(messages => messages.filter(Boolean));

      if (messages.length > 0) {
        ws.send(JSON.stringify({
          type: 'history',
          messages
        }));
      }
    }

    // 设置 Redis 订阅
    await subscriber.subscribe(roomChannel);
    
    // 监听 Redis 消息
    subscriber.on('message', async (channel, message) => {
      if (channel === roomChannel && ws.readyState === WebSocket.OPEN) {
        try {
          const parsedMessage = JSON.parse(message);
          
          // 如果是加密消息，先解密
          if (parsedMessage.encrypted) {
            const decryptedMessage = await CryptoManager.decryptMessage(parsedMessage as InternalEncryptedMessage, roomKey!);
            ws.send(JSON.stringify(decryptedMessage));
          } else {
            // 未加密消息直接转发
            ws.send(message);
          }
        } catch (err) {
          console.error('消息处理失败:', err);
        }
      }
    });

    // 处理 WebSocket 消息
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString()) as ChatMessage & {
          action?: 'edit' | 'delete';
          messageId?: string;
        };

        // 处理删除消息（支持 type 或 action 字段）
        if (message.type === 'delete' || message.action === 'delete') {
          if (!message.messageId) {
            const errorMessage: ChatMessage = {
              type: 'error',
              roomId: params.roomId,
              userId: 'system',
              content: '消息ID不能为空',
              timestamp: Date.now()
            };
            const encryptedError = await CryptoManager.encryptMessage(errorMessage, roomKey!);
            ws.send(JSON.stringify(encryptedError));
            return;
          }

          // 删除消息
          const success = await RoomManager.deleteMessage(
            params.roomId,
            message.messageId,
            ws.userId
          );

          if (success) {
            // 广播消息删除
            const deleteMessage: ChatMessage = {
              type: 'system',
              roomId: params.roomId,
              userId: 'system',
              content: JSON.stringify({
                action: 'delete',
                messageId: message.messageId
              }),
              timestamp: Date.now()
            };
            const encryptedDelete = await CryptoManager.encryptMessage(deleteMessage, roomKey!);
            await redis.publish(roomChannel, JSON.stringify(encryptedDelete));
          } else {
            const errorMessage: ChatMessage = {
              type: 'error',
              roomId: params.roomId,
              userId: 'system',
              content: '删除消息失败',
              timestamp: Date.now()
            };
            const encryptedError = await CryptoManager.encryptMessage(errorMessage, roomKey!);
            ws.send(JSON.stringify(encryptedError));
          }
          return;
        }

        // 处理编辑消息
        if (message.type === 'edit' || message.action === 'edit') {
          if (!message.messageId || !message.content) {
            const errorMessage: ChatMessage = {
              type: 'error',
              roomId: params.roomId,
              userId: 'system',
              content: '消息ID和内容不能为空',
              timestamp: Date.now()
            };
            const encryptedError = await CryptoManager.encryptMessage(errorMessage, roomKey!);
            ws.send(JSON.stringify(encryptedError));
            return;
          }

          const chatMessage: ChatMessage = {
            type: 'message',
            roomId: params.roomId,
            userId: ws.userId,
            content: message.content,
            timestamp: Date.now(),
            fileMeta: message.fileMeta
          };

          // 加密新消息
          const encryptedMessage = await CryptoManager.encryptMessage(chatMessage, roomKey!);
          
          // 修改消息
          const success = await RoomManager.editMessage(
            params.roomId,
            message.messageId,
            ws.userId,
            encryptedMessage
          );

          if (success) {
            // 广播消息更新
            const updateMessage: ChatMessage = {
              type: 'system',
              roomId: params.roomId,
              userId: 'system',
              content: JSON.stringify({
                action: 'edit',
                messageId: message.messageId,
                newMessage: chatMessage
              }),
              timestamp: Date.now()
            };
            const encryptedUpdate = await CryptoManager.encryptMessage(updateMessage, roomKey!);
            await redis.publish(roomChannel, JSON.stringify(encryptedUpdate));
          } else {
            const errorMessage: ChatMessage = {
              type: 'error',
              roomId: params.roomId,
              userId: 'system',
              content: '修改消息失败',
              timestamp: Date.now()
            };
            const encryptedError = await CryptoManager.encryptMessage(errorMessage, roomKey!);
            ws.send(JSON.stringify(encryptedError));
          }
          return;
        }

        // 处理普通消息
        if (message.type === 'message' || (!message.type && !message.action)) {
        if (!message.content) {
          const errorMessage: ChatMessage = {
            type: 'error',
            roomId: params.roomId,
            userId: 'system',
            content: '消息内容不能为空',
            timestamp: Date.now()
          };
          const encryptedError = await CryptoManager.encryptMessage(errorMessage, roomKey!);
          ws.send(JSON.stringify(encryptedError));
          return;
        }

        const chatMessage: ChatMessage = {
          type: 'message',
          roomId: params.roomId,
          userId: ws.userId,
          content: message.content,
          timestamp: Date.now(),
          fileMeta: message.fileMeta
        };

        // 加密消息
        const encryptedMessage = await CryptoManager.encryptMessage(chatMessage, roomKey!);
        const messageStr = JSON.stringify(encryptedMessage);

        // 发布消息到 Redis
        await redis.publish(roomChannel, messageStr);
        // 持久化存储
        await redis.xadd(roomChannel, '*', 'message', messageStr);
        }

      } catch (err) {
        const errorMessage: ChatMessage = {
          type: 'error',
          roomId: params.roomId,
          userId: 'system',
          content: '消息格式错误',
          timestamp: Date.now()
        };
        const encryptedError = await CryptoManager.encryptMessage(errorMessage, roomKey!);
        ws.send(JSON.stringify(encryptedError));
      }
    });

    // 心跳检测
    const pingInterval = setInterval(() => {
      if (!ws.isAlive) {
        clearInterval(pingInterval);
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    }, 30000);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // 处理连接关闭
    ws.on('close', async () => {
      clearInterval(pingInterval);
      await subscriber.unsubscribe(roomChannel);

      // 移除在线用户
      await RoomManager.removeOnlineUser(params.roomId, params.userId);

      // 获取更新后的在线用户列表并推送
      const updatedOnlineUsers = await RoomManager.getOnlineUsers(params.roomId);
      const onlineListMessage: ChatMessage = {
        type: 'onlineList',
        roomId: params.roomId,
        userId: 'system',
        content: JSON.stringify(updatedOnlineUsers),
        timestamp: Date.now()
      };
      await redis.publish(roomChannel, JSON.stringify(onlineListMessage));

      // 发送离开消息
      const leaveMessage: ChatMessage = {
        type: 'leave',
        roomId: params.roomId,
        userId: params.userId,
        content: `用户 ${params.userId} 离开了房间`,
        timestamp: Date.now()
      };

      await redis.publish(roomChannel, JSON.stringify(leaveMessage));
    });
  };

  fastify.get('/ws', { websocket: true }, handler);
} 