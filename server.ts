import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import { config } from './config/env';
import websocketRoutes from './routes/websocket';
import historyRoutes from './routes/history';
import uploadRoutes from './routes/upload';
import emojiRoutes from './routes/emoji';
const fastify = Fastify({
  logger: !config.isProduction, // 只在非生产环境开启日志
});

// 注册 CORS 插件
fastify.register(fastifyCors, {
  origin: true, // 允许所有来源
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
});

// 注册 WebSocket 插件
fastify.register(fastifyWebsocket, {
  options: {
    // WebSocket 选项
    clientTracking: true,
    // 10MB 最大消息大小
    maxPayload: 10 * 1024 * 1024,
  }
});

// 注册路由
fastify.register(websocketRoutes);
fastify.register(historyRoutes);
fastify.register(uploadRoutes);
fastify.register(emojiRoutes);

// 基础路由示例
fastify.get('/', async (request, reply) => {
  return { hello: 'world' };
});

const start = async () => {
  try {
    await fastify.listen({ port: 3000, host: '0.0.0.0' });
    fastify.log.info(`Server listening on http://localhost:3000`);
    console.log(`Server listening on http://localhost:3000`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start(); 