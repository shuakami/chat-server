import { redis } from '../config/redis';
import { compare, hash } from 'bcrypt';
import { ChatMessage, InternalEncryptedMessage } from '../types/websocket';
import { config } from '../config/env';
import { CryptoManager } from './crypto';

const SALT_ROUNDS = 10;
const ROOM_PASSWORD_PREFIX = 'room:pwd:';
const ROOM_STREAM_PREFIX = 'chat:room:';
const ROOM_USERS_PREFIX = 'room:users:';
const ROOM_MEMBERS_PREFIX = 'room:members:';
const ROOM_PEEKING_USERS_PREFIX = 'room:peeking:';
const ROOM_META_PREFIX = 'room:meta:';
const STREAM_SUFFIX = '';
const DEFAULT_COUNT = 50;

// Helper function for edit map key
const getEditMapKey = (roomId: string, clientMessageId: string) => `edit_map:${roomId}:${clientMessageId}`;

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
   * @param message 加密消息 (InternalEncryptedMessage)。其对应的 ChatMessage 在加密前，其 messageId 字段应已包含客户端期望的原始消息ID（如果适用，例如回复或引用场景），或在发送新消息时由服务器生成后填充。
   */
  static async saveMessage(roomId: string, message: InternalEncryptedMessage): Promise<string | null> {
    const streamKey = `${ROOM_STREAM_PREFIX}${roomId}${STREAM_SUFFIX}`;
    // For brand new messages, the actual stream ID is what we get back from XADD *.
    // No entry in edit_map is created for brand new messages initially.
    // If this message is later edited, clientMessageId (from message.messageId inside ChatMessage) will be used for edit_map.
    return redis.xadd(
      streamKey,
      '*', // Always generate ID for new messages
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

    // console.log(`[RoomManager.getMessages] Querying stream: ${streamKey}, from: ${start}, to: ${end}, count: ${count}`);

    const rawMessages = await redis.xrange(streamKey, start, end);
    // console.log(`[RoomManager.getMessages] Raw messages from Redis for ${streamKey}:`, rawMessages);

    if (!rawMessages || !rawMessages.length) {
      // console.log(`[RoomManager.getMessages] No raw messages found for ${streamKey}.`);
      return [];
    }

    let messages = rawMessages.map(([id, fields]) => {
      try {
        const messageStr = fields[1];
        if (typeof messageStr === 'string') {
          return {
            id, // This is the actualStreamId
            message: JSON.parse(messageStr) as InternalEncryptedMessage
          };
        }
        // console.error(`Malformed message data for ID ${id}:`, fields);
        return null;
      } catch (e) {
        // console.error(`Error parsing message JSON for ID ${id}:`, e);
        return null;
      }
    }).filter(Boolean) as { id: string; message: InternalEncryptedMessage }[];
    
    if (messages.length > count) {
      messages = messages.slice(0, count);
    }
    
    return messages; // Returns actualStreamId, higher layer transforms to clientMessageId
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
            id, // This is the actualStreamId
            message: JSON.parse(messageStr) as InternalEncryptedMessage
          };
        }
        // console.error(`Malformed message data for ID ${id}:`, fields);
        return null;
      } catch (e) {
        // console.error(`Error parsing message JSON for ID ${id}:`, e);
        return null;
      }
    }).filter(Boolean) as { id: string; message: InternalEncryptedMessage }[];

    if (messages.length > count) {
      messages = messages.slice(0, count);
    }
    
    return messages.reverse(); // Returns actualStreamId, higher layer transforms
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
      `${ROOM_MEMBERS_PREFIX}${roomId}`,
      `${ROOM_PEEKING_USERS_PREFIX}${roomId}`,
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
   * @param clientMessageId 客户端使用的消息ID (原始ID)
   * @param userId 用户ID (进行操作的用户)
   * @param newMessageFullEncrypted 加密后的新消息数据 (InternalEncryptedMessage)
   * @param roomKey 房间的解密密钥
   */
  static async editMessage(
    roomId: string,
    clientMessageId: string,
    userId: string,
    newMessageFullEncrypted: InternalEncryptedMessage,
    roomKey: Buffer // 新增参数
  ): Promise<boolean> {
    const streamKey = `${ROOM_STREAM_PREFIX}${roomId}${STREAM_SUFFIX}`;
    const editMapKey = getEditMapKey(roomId, clientMessageId);

    try {
      const currentActualStreamId = (await redis.get(editMapKey)) || clientMessageId;

      // 1. Get original message and verify ownership
      const existingMessages = await redis.xrange(streamKey, currentActualStreamId, currentActualStreamId);
      if (!existingMessages || !existingMessages.length) {
        console.warn(`[RoomManager.editMessage] Original message (actual ID: ${currentActualStreamId} for client ID: ${clientMessageId}) not found. Cleaning map if exists.`);
        await redis.del(editMapKey);
        return false;
      }

      const originalMessageEncryptedStr = existingMessages[0][1][1];
      if (typeof originalMessageEncryptedStr !== 'string') {
        console.error(`[RoomManager.editMessage] Invalid original message format (actual ID: ${currentActualStreamId}).`);
        return false;
      }
      const originalMessageEncrypted = JSON.parse(originalMessageEncryptedStr) as InternalEncryptedMessage;
      
      try {
        const originalMessageDecrypted = await CryptoManager.decryptMessage(originalMessageEncrypted, roomKey);
        if (originalMessageDecrypted.userId !== userId) {
          console.error(`[RoomManager.editMessage] Permission denied for user ${userId} to edit message owned by ${originalMessageDecrypted.userId} (client ID: ${clientMessageId}).`);
          return false;
        }
      } catch (decryptError) {
        console.error(`[RoomManager.editMessage] Failed to decrypt original message for permission check (client ID: ${clientMessageId}):`, decryptError);
        return false; // Decryption failure means we can't verify ownership
      }

      // 2. Add new message to stream (always use '*' for new ID)
      const newActualStreamId = await redis.xadd(
        streamKey,
        '*', // Generate new ID
        'message',
        JSON.stringify(newMessageFullEncrypted) // This message's ChatMessage.messageId should be clientMessageId
      );

      if (!newActualStreamId) {
        console.error(`[RoomManager.editMessage] Failed to XADD new version for client ID ${clientMessageId}.`);
        return false;
      }

      // 3. Delete old version from stream
      // Important: Only delete if currentActualStreamId is different from clientMessageId (meaning it was an edit map hit)
      // OR if it's the first edit (currentActualStreamId IS clientMessageId).
      // In essence, always delete the currentActualStreamId that was found/used.
      const deletedCount = await redis.xdel(streamKey, currentActualStreamId);
      if (deletedCount === 0 && currentActualStreamId) {
         // currentActualStreamId could be null if redis.get returned null and clientMessageId was also somehow gone
        console.warn(`[RoomManager.editMessage] Old version (actual ID: ${currentActualStreamId}) not found for deletion during edit of client ID ${clientMessageId}.`);
      }

      // 4. Update the mapping to point to the new actual stream ID
      await redis.set(editMapKey, newActualStreamId);
      
      console.log(`[RoomManager.editMessage] Message (client ID: ${clientMessageId}) edited. New actual ID: ${newActualStreamId}. Old actual ID: ${currentActualStreamId} deleted.`);
      return true;
    } catch (err) {
      console.error(`[RoomManager.editMessage] Error editing message (client ID: ${clientMessageId}):`, err);
      return false;
    }
  }

  /**
   * 删除消息
   * @param roomId 房间ID
   * @param clientMessageId 客户端使用的消息ID
   * @param userId 用户ID
   * @param roomKey 房间的解密密钥
   */
  static async deleteMessage(
    roomId: string,
    clientMessageId: string,
    userId: string,
    roomKey: Buffer // 新增参数
  ): Promise<boolean> {
    const streamKey = `${ROOM_STREAM_PREFIX}${roomId}${STREAM_SUFFIX}`;
    const editMapKey = getEditMapKey(roomId, clientMessageId);

    try {
      const currentActualStreamId = (await redis.get(editMapKey)) || clientMessageId;

      // 1. Optionally, verify ownership before deleting.
      const existingMessages = await redis.xrange(streamKey, currentActualStreamId, currentActualStreamId);
      if (existingMessages && existingMessages.length > 0) {
        const messageToVerifyStr = existingMessages[0][1][1];
        if (typeof messageToVerifyStr === 'string') {
          const messageToVerifyEncrypted = JSON.parse(messageToVerifyStr) as InternalEncryptedMessage;
          try {
            const messageToVerifyDecrypted = await CryptoManager.decryptMessage(messageToVerifyEncrypted, roomKey);
            if (messageToVerifyDecrypted.userId !== userId) {
              console.error(`[RoomManager.deleteMessage] Permission denied for user ${userId} to delete message owned by ${messageToVerifyDecrypted.userId} (client ID: ${clientMessageId}).`);
              return false;
            }
          } catch (decryptError) {
            console.error(`[RoomManager.deleteMessage] Failed to decrypt message for permission check (client ID: ${clientMessageId}):`, decryptError);
            // If decryption fails, we might still allow deletion if desired (e.g. admin action),
            // but for user-initiated deletion, failing is safer.
            return false;
          }
        } else {
          console.warn(`[RoomManager.deleteMessage] Could not parse message string for verification (actual ID: ${currentActualStreamId}). Proceeding with deletion without full verification.`);
        }
      } else {
        console.warn(`[RoomManager.deleteMessage] Message not found in stream for verification (actual ID: ${currentActualStreamId}). It might have been already deleted.`);
        // If no message, nothing to verify ownership against, but we still want to clear the map entry.
      }

      // 2. Delete the message from stream
      const deletedCount = await redis.xdel(streamKey, currentActualStreamId);
      // Even if message in stream is not found (deletedCount === 0), proceed to delete map entry.
      if (deletedCount === 0 && currentActualStreamId) { // currentActualStreamId might be clientMessageId if map entry didn't exist
         console.warn(`[RoomManager.deleteMessage] Message (actual ID: ${currentActualStreamId} for client ID: ${clientMessageId}) not found in stream for deletion.`);
      }
      
      const mapDelCount = await redis.del(editMapKey); // Remove the mapping
      if(mapDelCount > 0) {
        console.log(`[RoomManager.deleteMessage] Edit map entry for client ID ${clientMessageId} deleted.`);
      }

      console.log(`[RoomManager.deleteMessage] Deletion processed for client ID: ${clientMessageId} (actual ID was: ${currentActualStreamId}).`);
      return true; // Operation is successful if the message and its map entry are gone or were already gone.
    } catch (err) {
      console.error(`[RoomManager.deleteMessage] Error deleting message (client ID: ${clientMessageId}):`, err);
      return false;
    }
  }

  /**
   * 将用户加入房间在线集合，并记录到房间历史成员列表
   */
  static async addOnlineUser(roomId: string, userId: string): Promise<void> {
    // 使用 SADD，如果用户已存在也不会报错
    await redis.sadd(`${ROOM_USERS_PREFIX}${roomId}`, userId);
    await redis.sadd(`${ROOM_MEMBERS_PREFIX}${roomId}`, userId); // 同时添加到历史成员
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
    const users = await redis.smembers(`${ROOM_USERS_PREFIX}${roomId}`);
    return users || [];
  }

  /**
   * 获取房间所有历史成员
   */
  static async getRoomMembers(roomId: string): Promise<string[]> {
    const members = await redis.smembers(`${ROOM_MEMBERS_PREFIX}${roomId}`);
    return members || [];
  }

  /**
   * 批量删除用户在房间内的所有消息
   * @param roomId 房间ID
   * @param userId 用户ID
   * @param roomKey 房间的解密密钥
   */
  static async deleteUserMessages(
    roomId: string,
    userId: string,
    roomKey: Buffer
  ): Promise<{ success: boolean; count: number }> {
    const streamKey = `${ROOM_STREAM_PREFIX}${roomId}${STREAM_SUFFIX}`;
    let deletedCount = 0;

    try {
      // 1. 获取所有消息，使用配置的最大消息数限制
      const messages = await this.getLatestMessages(roomId, config.room.maxMessages);
      
      // 2. 遍历消息，找出属于该用户的
      for (const { id, message } of messages) {
        try {
          const decrypted = await CryptoManager.decryptMessage(message, roomKey);
          if (decrypted.userId === userId) {
            // 删除消息
            const deleted = await redis.xdel(streamKey, id);
            if (deleted > 0) {
              deletedCount++;
              // 删除编辑映射（如果存在）
              if (decrypted.messageId) {
                const editMapKey = getEditMapKey(roomId, decrypted.messageId);
                await redis.del(editMapKey);
              }
            }
          }
        } catch (decryptError) {
          console.error(`解密消息失败 (ID: ${id}):`, decryptError);
          continue;
        }
      }

      return { success: true, count: deletedCount };
    } catch (err) {
      console.error(`批量删除用户消息失败 (用户: ${userId}, 房间: ${roomId}):`, err);
      return { success: false, count: deletedCount };
    }
  }


  /**
   * 设置用户的窥屏状态
   * @param roomId 房间ID
   * @param userId 用户ID
   * @param isVisible 用户是否正在窥屏 (页面可见)
   */
  static async setPeekingStatus(roomId: string, userId: string, isVisible: boolean): Promise<void> {
    const peekingKey = `${ROOM_PEEKING_USERS_PREFIX}${roomId}`;
    try {
      if (isVisible) {
        await redis.sadd(peekingKey, userId);
      } else {
        await redis.srem(peekingKey, userId);
      }
    } catch (err) {
      console.error(`设置用户 ${userId} 在房间 ${roomId} 的窥屏状态失败:`, err);
      // 根据需要决定是否抛出错误或如何处理
    }
  }

  /**
   * 获取房间内所有正在窥屏的用户ID
   * @param roomId 房间ID
   */
  static async getPeekingUsers(roomId: string): Promise<string[]> {
    const peekingKey = `${ROOM_PEEKING_USERS_PREFIX}${roomId}`;
    try {
      const users = await redis.smembers(peekingKey);
      return users || [];
    } catch (err) {
      console.error(`获取房间 ${roomId} 的窥屏用户列表失败:`, err);
      return []; // 出错时返回空列表
    }
  }
} 