import Redis from 'ioredis';
import { config } from './env';

// 打印所有环境变量
console.log('=== 环境变量 ===');
Object.keys(process.env).forEach(key => {
  console.log(`${key}=${process.env[key]}`);
});
console.log('=== 环境变量结束 ===');

// 打印 Redis 配置
console.log('=== Redis 配置 ===');
console.log('Redis URL:', config.redis.url);
console.log('Redis Token:', config.redis.token ? '已设置' : '未设置');
console.log('=== Redis 配置结束 ===');

if (!config.redis.url) {
  throw new Error('Redis URL must be defined in environment variables.');
}

// 判断是否是本地 Redis
const isLocalRedis = config.redis.url.includes('127.0.0.1') || config.redis.url.includes('localhost');
console.log('是否本地 Redis:', isLocalRedis);

// Redis 连接配置
const redisConfig = {
  retryStrategy(times: number) {
    const delay = Math.min(times * 50, 2000);
    console.log(`Redis 重试连接 #${times}, 延迟 ${delay}ms`);
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  showFriendlyErrorStack: true,
  lazyConnect: false,
  // 如果不是本地 Redis，启用 TLS
  tls: !isLocalRedis ? {
    rejectUnauthorized: false // 在生产环境中应该设置为 true
  } : undefined
};

console.log('Redis 连接配置:', JSON.stringify(redisConfig, null, 2));

// 创建两个独立的 Redis 客户端
export const redis = new Redis(config.redis.url, redisConfig);
export const subscriber = new Redis(config.redis.url, redisConfig);

// 连接事件处理
redis.on('connect', () => {
  console.log('Redis 客户端: 正在连接...');
});

redis.on('ready', () => {
  console.log('Redis 客户端: 连接就绪');
});

redis.on('error', (err) => {
  console.error('Redis 客户端错误:', err);
});

redis.on('close', () => {
  console.log('Redis 客户端: 连接关闭');
});

redis.on('reconnecting', () => {
  console.log('Redis 客户端: 正在重新连接...');
});

subscriber.on('connect', () => {
  console.log('Redis 订阅客户端: 正在连接...');
});

subscriber.on('ready', () => {
  console.log('Redis 订阅客户端: 连接就绪');
});

subscriber.on('error', (err) => {
  console.error('Redis 订阅客户端错误:', err);
});

subscriber.on('close', () => {
  console.log('Redis 订阅客户端: 连接关闭');
});

subscriber.on('reconnecting', () => {
  console.log('Redis 订阅客户端: 正在重新连接...');
}); 