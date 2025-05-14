import Redis from 'ioredis';
import { config } from './env';

if (!config.redis.url) {
  throw new Error('Redis URL must be defined in environment variables.');
}

// 判断是否是本地 Redis
const isLocalRedis = config.redis.url.includes('127.0.0.1') || config.redis.url.includes('localhost');

// Redis 连接配置
const redisConfig = {
  retryStrategy(times: number) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  // 如果不是本地 Redis，启用 TLS
  tls: !isLocalRedis ? {
    rejectUnauthorized: false // 在生产环境中应该设置为 true
  } : undefined
};

// 创建两个独立的 Redis 客户端
export const redis = new Redis(config.redis.url, redisConfig);
export const subscriber = new Redis(config.redis.url, redisConfig);

// 错误处理
redis.on('error', (err) => {
  console.error('Redis client error:', err);
});

subscriber.on('error', (err) => {
  console.error('Redis subscriber error:', err);
}); 