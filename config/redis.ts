import Redis from 'ioredis';
import { config } from './env';

if (!config.redis.url) {
  throw new Error('Redis URL must be defined in environment variables.');
}

// 创建两个独立的 Redis 客户端
export const redis = new Redis(config.redis.url);
export const subscriber = new Redis(config.redis.url); 