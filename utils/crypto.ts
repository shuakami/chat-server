import { KeyDerivationConfig, EncryptedPayload, MessageContent, ChatMessage, InternalEncryptedMessage } from '../types/websocket';
import { redis } from '../config/redis';
import crypto from 'crypto';

const ROOM_KEY_PREFIX = 'room:key:';

export class CryptoManager {
  // PBKDF2 配置
  private static readonly DEFAULT_ITERATIONS = 100000;
  private static readonly DEFAULT_KEY_LENGTH = 256;
  private static readonly SALT_LENGTH = 16;

  /**
   * 为房间生成新的加密密钥
   * @param roomId 房间ID
   */
  static async generateRoomKey(roomId: string): Promise<void> {
    const key = crypto.randomBytes(32); // 256位密钥
    await redis.set(`${ROOM_KEY_PREFIX}${roomId}`, key.toString('base64'));
  }

  /**
   * 获取房间的加密密钥
   * @param roomId 房间ID
   */
  static async getRoomKey(roomId: string): Promise<Buffer | null> {
    const key = await redis.get(`${ROOM_KEY_PREFIX}${roomId}`);
    if (!key || typeof key !== 'string') return null;
    return Buffer.from(key, 'base64');
  }

  /**
   * 加密消息
   * @param message 原始消息
   * @param key 加密密钥
   */
  static async encryptMessage(message: ChatMessage, key: Buffer): Promise<InternalEncryptedMessage> {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    // 加密整个消息内容，包括 fileMeta
    const data = Buffer.concat([
      cipher.update(JSON.stringify({
        content: message.content,
        type: message.type,
        timestamp: message.timestamp,
        fileMeta: message.fileMeta
      })),
      cipher.final()
    ]);

    const tag = cipher.getAuthTag();

    // 返回时不包含原始的 fileMeta
    const { fileMeta, ...messageWithoutFileMeta } = message;
    return {
      ...messageWithoutFileMeta,
      encrypted: true,
      payload: {
        cipher: 'AES-256-GCM',
        iv: iv.toString('base64'),
        data: data.toString('base64'),
        tag: tag.toString('base64')
      }
    };
  }

  /**
   * 解密消息
   * @param message 加密消息
   * @param key 解密密钥
   */
  static async decryptMessage(message: InternalEncryptedMessage, key: Buffer): Promise<ChatMessage> {
    if (!message?.payload?.iv || !message?.payload?.data) {
      throw new Error('Invalid message format: missing required encryption fields');
    }

    const iv = Buffer.from(message.payload.iv, 'base64');
    const data = Buffer.from(message.payload.data, 'base64');
    const tag = Buffer.from(message.payload.tag || '', 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    const decrypted = JSON.parse(
      Buffer.concat([
        decipher.update(data),
        decipher.final()
      ]).toString()
    );

    const { encrypted, payload, ...rest } = message;
    return {
      ...rest,
      content: decrypted.content,
      type: decrypted.type,
      timestamp: decrypted.timestamp,
      fileMeta: decrypted.fileMeta
    };
  }

  /**
   * 删除房间密钥
   * @param roomId 房间ID
   */
  static async deleteRoomKey(roomId: string): Promise<void> {
    await redis.del(`${ROOM_KEY_PREFIX}${roomId}`);
  }
} 