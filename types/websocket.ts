import { WebSocket } from 'ws';
import type { FastifyRequest } from 'fastify';

export type MessageType = 'text' | 'markdown' | 'image' | 'audio' | 'file';

export interface FileMeta {
  fileName: string;
  fileSize: number;
  mimeType: string;
}

export interface MessageContent {
  type: MessageType;
  content: string;
  fileMeta?: FileMeta;
  from: string;
  timestamp: number;
}

export interface EncryptedPayload {
  cipher: 'AES-256-GCM';
  iv: string;  // base64
  data: string; // base64
  tag?: string; // base64, AES-GCM 认证标签
}

export interface EncryptedMessage {
  room: string;
  from: string;
  payload: EncryptedPayload;
}

export interface ChatMessage {
  type: 'message' | 'system' | 'join' | 'leave' | 'error' | 'delete' | 'edit' | 'onlineList';
  roomId: string;
  userId: string;
  content: string;
  timestamp: number;
  fileMeta?: FileMeta;
  messageId?: string;  // 添加messageId字段用于编辑和删除操作
}

// 系统消息内容类型
export interface SystemMessageContent {
  action: 'edit' | 'delete';
  messageId: string;
  newMessage?: ChatMessage;
}

// 内部使用的加密消息格式
export interface InternalEncryptedMessage {
  type: 'message' | 'system' | 'join' | 'leave' | 'error' | 'delete' | 'edit';
  roomId: string;
  userId: string;
  timestamp: number;
  encrypted: true;
  payload: EncryptedPayload;
  fileMeta?: FileMeta;
}

export interface WebSocketConnection extends WebSocket {
  userId: string;
  roomId: string;
  isAlive: boolean;
}

export interface ConnectionParams {
  roomId: string;
  userId: string;
}

// 用于客户端的密钥派生配置
export interface KeyDerivationConfig {
  algorithm: 'PBKDF2';
  iterations: number;
  salt: string; // base64
  hash: 'SHA-256';
  keyLength: number; // bits
}

export interface FastifyWebsocketRouteOptions {
  websocket: true;
}

declare module '@fastify/websocket' {
  export interface SocketStream {
    socket: import('ws').WebSocket;
  }
} 