import { redis } from '../config/redis';
import { compare, hash } from 'bcrypt';
import { ChatMessage, InternalEncryptedMessage } from '../types/websocket';
import { config } from '../config/env';
import { CryptoManager } from './crypto';

const SALT_ROUNDS = 10;
const ROOM_PASSWORD_PREFIX = 'room:pwd:';
const ROOM_STREAM_PREFIX = 'chat:room:';
const ROOM_USERS_PREFIX = 'room:users:';
const ROOM_META_PREFIX = 'room:meta:';
const STREAM_SUFFIX = '';
const DEFAULT_COUNT = 50;

type RedisStreamMessageValue = { message: string; [key: string]: unknown };
type RedisStreamObject = Record<string, RedisStreamMessageValue>;

interface RedisStreamEntry {
  id: string;
  message: string;
}

interface RedisStreamResult {
  [key: string]: {
    message: string;
    [key: string]: unknown;
  };
}

export class RoomManager {
  static async setPassword(roomId: string, password: string): Promise<void> {
    const hashedPassword = await hash(password, SALT_ROUNDS);
    await redis.set(`${ROOM_PASSWORD_PREFIX}${roomId}`, hashedPassword);
  }

  static async verifyPassword(roomId: string, password: string): Promise<boolean> {
    const hashedPassword = await redis.get(`${ROOM_PASSWORD_PREFIX}${roomId}`);
    if (typeof hashedPassword !== 'string') {
      return false;
    }
    return await compare(password, hashedPassword);
  }

  /**
   * 保存消息到Redis Stream
   * @param roomId 房间ID
   * @param message 加密消息
   */
  static async saveMessage(roomId: string, message: InternalEncryptedMessage): Promise<string | null> {
    const streamKey = `${ROOM_STREAM_PREFIX}${roomId}${STREAM_SUFFIX}`;
    return redis.xadd(
      streamKey,
      '*',
      'message',
      JSON.stringify(message)
    );
  }

  /**
   * 获取指定时间范围内的消息
   * @param roomId 房间ID
   * @param from 起始时间戳（毫秒）
   * @param to 结束时间戳（毫秒），默认为当前时间
   * @param count 返回消息数量
   */
  static async getMessages(
    roomId: string,
    from?: number,
    to: number = Date.now(),
    count: number = DEFAULT_COUNT
  ): Promise<{ id: string; message: InternalEncryptedMessage }[]> {
    const streamKey = `${ROOM_STREAM_PREFIX}${roomId}${STREAM_SUFFIX}`;
    const start = from ? from.toString() : '-';
    const end = to.toString();

    console.log(`[RoomManager.getMessages] Querying stream: ${streamKey}, from: ${start}, to: ${end}, count: ${count}`);

    const rawMessages = await redis.xrange(streamKey, start, end);
    console.log(`[RoomManager.getMessages] Raw messages from Redis for ${streamKey}:`, rawMessages);

    if (!rawMessages || !rawMessages.length) {
      console.log(`[RoomManager.getMessages] No raw messages found for ${streamKey}.`);
      return [];
    }

    let messages = rawMessages.map(([id, fields]) => {
      try {
        const messageStr = fields[1];
        if (typeof messageStr === 'string') {
          return {
            id,
            message: JSON.parse(messageStr) as InternalEncryptedMessage
          };
        }
        console.error(`Malformed message data for ID ${id}:`, fields);
        return null;
      } catch (e) {
        console.error(`Error parsing message JSON for ID ${id}:`, e);
        return null;
      }
    }).filter(Boolean) as { id: string; message: InternalEncryptedMessage }[];
    
    if (messages.length > count) {
      messages = messages.slice(0, count);
    }
    
    return messages;
  }

  /**
   * 获取最新的消息
   * @param roomId 房间ID
   * @param count 返回消息数量
   */
  static async getLatestMessages(
    roomId: string,
    count: number = DEFAULT_COUNT
  ): Promise<{ id: string; message: InternalEncryptedMessage }[]> {
    const streamKey = `${ROOM_STREAM_PREFIX}${roomId}${STREAM_SUFFIX}`;
    
    const rawMessages = await redis.xrevrange(streamKey, '+', '-');
    if (!rawMessages || !rawMessages.length) return [];

    let messages = rawMessages.map(([id, fields]) => {
      try {
        const messageStr = fields[1];
        if (typeof messageStr === 'string') {
          return {
            id,
            message: JSON.parse(messageStr) as InternalEncryptedMessage
          };
        }
        console.error(`Malformed message data for ID ${id}:`, fields);
        return null;
      } catch (e) {
        console.error(`Error parsing message JSON for ID ${id}:`, e);
        return null;
      }
    }).filter(Boolean) as { id: string; message: InternalEncryptedMessage }[];

    if (messages.length > count) {
      messages = messages.slice(0, count);
    }
    
    return messages.reverse();
  }

  static async roomExists(roomId: string): Promise<boolean> {
    return Boolean(await redis.exists(`${ROOM_PASSWORD_PREFIX}${roomId}`));
  }

  static async deleteRoom(roomId: string): Promise<void> {
    const passwordKey = `${ROOM_PASSWORD_PREFIX}${roomId}`;
    const streamKey = `${ROOM_STREAM_PREFIX}${roomId}${STREAM_SUFFIX}`;
    
    await Promise.all([
      redis.del(passwordKey),
      redis.del(streamKey)
    ]);
  }

  /**
   * 清理指定时间之前的消息
   * @param roomId 房间ID
   * @param before 清理该时间戳之前的消息
   */
  static async trimMessages(roomId: string, before: number): Promise<void> {
    const streamKey = `${ROOM_STREAM_PREFIX}${roomId}${STREAM_SUFFIX}`;
    await redis.xtrim(streamKey, 'MINID', before.toString());
  }

  /**
   * 获取所有房间ID
   */
  static async getAllRoomIds(): Promise<string[]> {
    const keys = await redis.keys(`${ROOM_PASSWORD_PREFIX}*`);
    return keys.map(key => key.replace(ROOM_PASSWORD_PREFIX, ''));
  }

  /**
   * 获取房间最后活跃时间
   * @param roomId 房间ID
   */
  static async getLastActiveTime(roomId: string): Promise<number> {
    const streamKey = `${ROOM_STREAM_PREFIX}${roomId}${STREAM_SUFFIX}`;
    try {
      const result = await redis.xrevrange(streamKey, '+', '-', 'COUNT', 1);
      if (!result || !result.length) {
        return 0;
      }
      
      const [id] = result[0];
      // 从消息ID中提取时间戳（毫秒）
      const timestamp = id.split('-')[0];
      return parseInt(timestamp, 10);
    } catch (err) {
      console.error('获取房间最后活跃时间失败:', err);
      return 0;
    }
  }

  /**
   * 清理单个房间的过期消息
   * @param roomId 房间ID
   */
  static async trimRoomMessages(roomId: string): Promise<void> {
    const streamKey = `${ROOM_STREAM_PREFIX}${roomId}${STREAM_SUFFIX}`;
    await redis.xtrim(streamKey, 'MAXLEN', '1000');
  }

  /**
   * 删除房间所有数据
   * @param roomId 房间ID
   */
  static async deleteRoomData(roomId: string): Promise<void> {
    const keys = [
      `${ROOM_PASSWORD_PREFIX}${roomId}`,
      `${ROOM_STREAM_PREFIX}${roomId}${STREAM_SUFFIX}`,
      `${ROOM_USERS_PREFIX}${roomId}`,
      `${ROOM_META_PREFIX}${roomId}`
    ];
    
    await Promise.all(keys.map(key => redis.del(key)));
  }

  /**
   * 清理不活跃的房间
   */
  static async cleanupInactiveRooms(): Promise<void> {
    const rooms = await RoomManager.getAllRoomIds();
    const now = Date.now();
    const inactiveThreshold = 7 * 24 * 60 * 60 * 1000; // 7天

    for (const roomId of rooms) {
      const lastActive = await RoomManager.getLastActiveTime(roomId);
      if (now - lastActive > inactiveThreshold) {
        await RoomManager.deleteRoomData(roomId);
      }
    }
  }

  /**
   * 修改消息
   * @param roomId 房间ID
   * @param messageId 消息ID
   * @param userId 用户ID
   * @param newMessage 新的消息内容
   */
  static async editMessage(
    roomId: string,
    messageId: string,
    userId: string,
    newMessage: InternalEncryptedMessage
  ): Promise<boolean> {
    const streamKey = `${ROOM_STREAM_PREFIX}${roomId}${STREAM_SUFFIX}`;
    
    // 获取原消息
    const messages = await redis.xrange(streamKey, messageId, messageId);
    if (!messages || !messages.length) {
      console.error(`[RoomManager.editMessage] Message not found: ${messageId}`);
      return false;
    }

    // 解析原消息
    const messageStr = messages[0][1][1];
    if (typeof messageStr !== 'string') {
      console.error(`[RoomManager.editMessage] Invalid message format: ${messageId}`);
      return false;
    }

    const originalMessage = JSON.parse(messageStr) as InternalEncryptedMessage;
    
    // 验证消息所有者
    if (originalMessage.userId !== userId) {
      console.error(`[RoomManager.editMessage] Permission denied: ${userId} trying to edit message from ${originalMessage.userId}`);
      return false;
    }

    // 先添加新消息，再删除旧消息
    try {
      // 添加新消息
      const newMessageId = await redis.xadd(
        streamKey,
        '*',  // 使用自动生成的ID
        'message',
        JSON.stringify({
          ...newMessage,
          originalMessageId: messageId  // 保存原消息ID的引用
        })
      );

      if (!newMessageId) {
        console.error(`[RoomManager.editMessage] Failed to add new message`);
        return false;
      }

      // 删除旧消息
      await redis.xdel(streamKey, messageId);
      
      return true;
    } catch (err) {
      console.error(`[RoomManager.editMessage] Failed to edit message: ${messageId}`, err);
      return false;
    }
  }

  /**
   * 删除消息
   * @param roomId 房间ID
   * @param messageId 消息ID
   * @param userId 用户ID
   */
  static async deleteMessage(
    roomId: string,
    messageId: string,
    userId: string
  ): Promise<boolean> {
    const streamKey = `${ROOM_STREAM_PREFIX}${roomId}${STREAM_SUFFIX}`;
    
    // 获取原消息
    const messages = await redis.xrange(streamKey, messageId, messageId);
    if (!messages || !messages.length) {
      console.error(`[RoomManager.deleteMessage] Message not found: ${messageId}`);
      return false;
    }

    // 解析原消息
    const messageStr = messages[0][1][1];
    if (typeof messageStr !== 'string') {
      console.error(`[RoomManager.deleteMessage] Invalid message format: ${messageId}`);
      return false;
    }

    const originalMessage = JSON.parse(messageStr) as InternalEncryptedMessage;
    
    // 验证消息所有者
    if (originalMessage.userId !== userId) {
      console.error(`[RoomManager.deleteMessage] Permission denied: ${userId} trying to delete message from ${originalMessage.userId}`);
      return false;
    }

    // 删除消息
    try {
      await redis.xdel(streamKey, messageId);
      return true;
    } catch (err) {
      console.error(`[RoomManager.deleteMessage] Failed to delete message: ${messageId}`, err);
      return false;
    }
  }

  /**
   * 将用户加入房间在线集合
   */
  static async addOnlineUser(roomId: string, userId: string): Promise<void> {
    await redis.sadd(`${ROOM_USERS_PREFIX}${roomId}`, userId);
  }

  /**
   * 将用户从房间在线集合移除
   */
  static async removeOnlineUser(roomId: string, userId: string): Promise<void> {
    await redis.srem(`${ROOM_USERS_PREFIX}${roomId}`, userId);
  }

  /**
   * 获取房间所有在线用户
   */
  static async getOnlineUsers(roomId: string): Promise<string[]> {
    return await redis.smembers(`${ROOM_USERS_PREFIX}${roomId}`) as string[];
  }
} 