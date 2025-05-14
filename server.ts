import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import { config } from './config/env';
import websocketRoutes from './routes/websocket';
import historyRoutes from './routes/history';
import uploadRoutes from './routes/upload';
import emojiRoutes from './routes/emoji';
import inviteRoutes from './routes/invite';

const fastify = Fastify({
  logger: !config.isProduction,
  trustProxy: true // 信任代理，这对于 Render 很重要
});

// 注册 CORS 插件
fastify.register(fastifyCors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
});

// 注册 WebSocket 插件
fastify.register(fastifyWebsocket, {
  options: {
    clientTracking: true,
    maxPayload: 10 * 1024 * 1024,
  }
});

// 注册路由
fastify.register(websocketRoutes);
fastify.register(historyRoutes);
fastify.register(uploadRoutes);
fastify.register(emojiRoutes);
fastify.register(inviteRoutes);

// 基础路由示例
fastify.get('/', async (request, reply) => {
  const uptime = process.uptime();
  const uptimeFormatted = {
    days: Math.floor(uptime / 86400),
    hours: Math.floor((uptime % 86400) / 3600),
    minutes: Math.floor((uptime % 3600) / 60),
    seconds: Math.floor(uptime % 60)
  };

  return {
    status: 'healthy',
    version: '1.0.1',
    uptime: uptimeFormatted,
    environment: config.isProduction ? 'production' : 'development',
    timestamp: new Date().toISOString()
  };
});

const start = async () => {
  try {
    // 使用自定义端口
    const port = process.env.PORT ? parseInt(process.env.PORT) : 14514;
    const host = '0.0.0.0'; // 监听所有网络接口

    await fastify.listen({ port, host });
    fastify.log.info(`Server listening on port ${port}`);
    console.log(`Server listening on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start(); 