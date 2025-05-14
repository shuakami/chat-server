import dotenv from 'dotenv';

dotenv.config();

export interface Config {
  redis: {
    url: string;
    token: string;
  };
  jwt: {
    secret: string;
  };
  room: {
    ttl: number;
    maxMessages: number;      // 每个房间最大消息数
    inactiveTtl: number;     // 房间不活跃超时时间（秒）
    cleanupInterval: number; // 清理任务执行间隔（秒）
  };
  isProduction: boolean;
  dogecloud: {
    accessKey: string;
    secretKey: string;
    bucket: string;
  };
  resend: {
    apiKey: string;
    fromEmail: string;
  };
}

export const config: Config = {
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    token: process.env.REDIS_TOKEN || ''
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'your-secret-key'
  },
  room: {
    ttl: parseInt(process.env.ROOM_TTL || '86400', 10),
    maxMessages: parseInt(process.env.ROOM_MAX_MESSAGES || '5000', 10),
    inactiveTtl: parseInt(process.env.ROOM_INACTIVE_TTL || '2592000', 10), // 30天
    cleanupInterval: parseInt(process.env.ROOM_CLEANUP_INTERVAL || '86400', 10) // 24小时
  },
  isProduction: process.env.NODE_ENV === 'production',
  dogecloud: {
    accessKey: process.env.DOGECLOUD_ACCESS_KEY || '',
    secretKey: process.env.DOGECLOUD_SECRET_KEY || '',
    bucket: process.env.DOGECLOUD_BUCKET || ''
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY || 're_',
    fromEmail: process.env.RESEND_FROM_EMAIL || 'noreply@email.sdjz.wiki'
  } 
};  