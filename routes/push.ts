import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { redis } from '../config/redis';
import { config } from '../config/env';
import { FromSchema } from 'json-schema-to-ts';
import axios from 'axios';

const GLOBAL_PUSH_SUBSCRIPTION_PREFIX = 'push:sub:'; // 全局订阅
const ROOM_PUSH_SUBSCRIPTION_PREFIX = 'push:room:'; // 房间级订阅 push:room:<roomId>:user:<userId>

// 初始化 web-push (如果 VAPID 密钥已配置)
if (config.vapid.publicKey && config.vapid.privateKey && config.vapid.subject) {
  console.log('VAPID details are configured locally, proxy will handle its own VAPID setup.');
} else {
  console.warn('Web Push VAPID details not fully configured in local config.json. Ensure proxy has VAPID configuration.');
}

const pushSubscriptionSchema = {
  type: 'object',
  properties: {
    endpoint: { type: 'string' },
    expirationTime: { type: ['number', 'null'] },
    keys: {
      type: 'object',
      properties: {
        p256dh: { type: 'string' },
        auth: { type: 'string' }
      },
      required: ['p256dh', 'auth']
    }
  },
  required: ['endpoint', 'keys']
} as const;

// 订阅请求体，增加了 roomId 用于房间级订阅
const subscribeBodySchema = {
  type: 'object',
  properties: {
    userId: { type: 'string' },
    subscription: pushSubscriptionSchema,
    roomId: { type: 'string' } // 可选，用于房间级订阅
  },
  required: ['userId', 'subscription']
} as const;

// 取消订阅请求体，增加了 roomId
const unsubscribeBodySchema = {
  type: 'object',
  properties: {
    userId: { type: 'string' },
    endpoint: { type: 'string' },
    roomId: { type: 'string' } // 可选，用于房间级订阅
  },
  required: ['userId', 'endpoint']
} as const;

const PROXY_ENCRYPT_URL = 'https://webhook.sdjz.wiki/api/fcm_proxy_encrypt';

/**
 * 向指定用户的所有特定订阅（全局或房间级）发送推送通知，通过加密代理
 * @param fastify Fastify 实例
 * @param userId 用户ID
 * @param originalPayload 推送负载 (明文 JSON 对象或字符串)
 * @param roomId 可选，如果提供，则只推送该房间的订阅
 */
export async function sendPushNotification(
  fastify: FastifyInstance,
  userId: string,
  originalPayload: object | string, // 接受对象或字符串作为原始 payload
  roomId?: string
): Promise<void> {
  // VAPID 密钥仍然建议在主应用 config 中配置，以明确依赖，即使代理实际使用它们
  if (!config.vapid.publicKey || !config.vapid.privateKey || !config.vapid.subject) {
    fastify.log.warn(`VAPID keys not configured in server's config.json. Proxy service needs these to function. Skipping push for user ${userId}.`);
    return;
  }

  let userSubscriptionKey: string;
  if (roomId) {
    userSubscriptionKey = `${ROOM_PUSH_SUBSCRIPTION_PREFIX}${roomId}:user:${userId}`;
  } else {
    userSubscriptionKey = `${GLOBAL_PUSH_SUBSCRIPTION_PREFIX}${userId}`;
  }

  try {
    const subscriptionsStr = await redis.smembers(userSubscriptionKey);
    if (!subscriptionsStr || subscriptionsStr.length === 0) {
      fastify.log.info(`No push subscriptions found for user ${userId} (key: ${userSubscriptionKey}). Skipping.`);
      return;
    }

    // const pushOptions = { TTL: 86400 }; // 24 hours, 如果代理支持，可以传递

    for (const subStr of subscriptionsStr) {
      try {
        const subscription = JSON.parse(subStr) as FromSchema<typeof pushSubscriptionSchema>;
        
        const proxyRequestBody = {
          subscription: subscription,
          payload: originalPayload, // 发送原始的，未stringify的（如果它是对象）
          // options: pushOptions // 如果代理支持并需要自定义 TTL 等选项
        };

        try {
          fastify.log.info(`Sending push to ${userId} via encrypting proxy for endpoint ${subscription.endpoint.substring(0, 50)}...`);
          const proxyResponse = await axios.post(PROXY_ENCRYPT_URL, proxyRequestBody, {
            validateStatus: function (status: number) { 
              return status >= 200 && status < 600;
            }
          });

          fastify.log.info(`Push to ${userId} via encrypting proxy for endpoint ${subscription.endpoint.substring(0,50)}... completed with status ${proxyResponse.status}`);

          if (proxyResponse.status === 404 || proxyResponse.status === 410) {
            fastify.log.info(`Subscription for ${userId} (endpoint: ${subscription.endpoint.substring(0,50)}...) is invalid (reported by proxy with status ${proxyResponse.status}). Removing.`);
            await redis.srem(userSubscriptionKey, subStr);
          } else if (proxyResponse.status < 200 || proxyResponse.status >= 300) {
            fastify.log.error(`Error sending push via encrypting proxy to ${userId} (endpoint: ${subscription.endpoint.substring(0,50)}...): Status ${proxyResponse.status}`, proxyResponse.data);
          }

        } catch (axiosError: any) {
          fastify.log.error(`Network error or other issue calling encrypting proxy for ${userId} (endpoint: ${subscription.endpoint.substring(0,50)}...):`, axiosError.message || axiosError);
          if (axiosError.response) {
            fastify.log.error('Encrypting proxy response error data:', axiosError.response.data);
          }
        }
      } catch (parseError) { 
        fastify.log.error(`Failed to parse subscription JSON for user ${userId} (key: ${userSubscriptionKey}): '${subStr}'`, parseError);
      }
    }
  } catch (redisError) {
    fastify.log.error(`Failed to retrieve push subscriptions for user ${userId} (key: ${userSubscriptionKey}) from Redis:`, redisError);
  }
}

export default async function pushRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/api/push/subscribe',
    { schema: { body: subscribeBodySchema } },
    async (request: FastifyRequest<{ Body: FromSchema<typeof subscribeBodySchema> }>, reply: FastifyReply) => {
      const { userId, subscription, roomId } = request.body;
      if (!userId) return reply.code(400).send({ error: '缺少 userId' });

      let userSubscriptionKey: string;
      let isRoomSubscription = false;
      if (roomId) {
        userSubscriptionKey = `${ROOM_PUSH_SUBSCRIPTION_PREFIX}${roomId}:user:${userId}`;
        isRoomSubscription = true;
        fastify.log.info(`用户 ${userId} 正在订阅房间 ${roomId} 的推送: ${subscription.endpoint}`);
      } else {
        userSubscriptionKey = `${GLOBAL_PUSH_SUBSCRIPTION_PREFIX}${userId}`;
        fastify.log.info(`用户 ${userId} 正在进行全局推送订阅: ${subscription.endpoint}`);
      }

      try {
        const addedCount = await redis.sadd(userSubscriptionKey, JSON.stringify(subscription));
        
        if (addedCount > 0) {
          // 新增订阅成功，发送欢迎推送
          const welcomePayload = {
            title: "订阅成功！",
            body: isRoomSubscription 
              ? `您已成功订阅房间 ${roomId} 的离线消息推送。` 
              : "您已成功订阅全局离线消息推送。",
            data: {
              roomId: isRoomSubscription ? roomId : undefined,
              isGlobal: !isRoomSubscription,
            }
          };
          // 异步发送，不阻塞主响应
          sendPushNotification(fastify, userId, welcomePayload, roomId).catch(err => {
            fastify.log.error(`发送订阅成功通知失败 for user ${userId}, room ${roomId}:`, err);
          });
          return reply.code(201).send({ success: true, message: '订阅成功，已发送确认通知。' });
        } else {
          // 订阅已存在
          return reply.code(200).send({ success: true, message: '订阅已存在，无需重复订阅。' });
        }
      } catch (error) {
        fastify.log.error('保存推送订阅失败:', error);
        return reply.code(500).send({ error: '保存订阅失败' });
      }
    }
  );

  fastify.post(
    '/api/push/unsubscribe',
    { schema: { body: unsubscribeBodySchema } },
    async (request: FastifyRequest<{ Body: FromSchema<typeof unsubscribeBodySchema> }>, reply: FastifyReply) => {
      const { userId, endpoint, roomId } = request.body;
      if (!userId || !endpoint) return reply.code(400).send({ error: '缺少 userId 或 endpoint' });

      let userSubscriptionKey: string;
      if (roomId) {
        userSubscriptionKey = `${ROOM_PUSH_SUBSCRIPTION_PREFIX}${roomId}:user:${userId}`;
        fastify.log.info(`用户 ${userId} 正在取消订阅房间 ${roomId} 的推送: ${endpoint}`);
      } else {
        userSubscriptionKey = `${GLOBAL_PUSH_SUBSCRIPTION_PREFIX}${userId}`;
        fastify.log.info(`用户 ${userId} 正在进行全局推送取消订阅: ${endpoint}`);
      }

      try {
        const subscriptions = await redis.smembers(userSubscriptionKey);
        let removed = false;
        for (const subStr of subscriptions) {
          try {
            const sub = JSON.parse(subStr) as FromSchema<typeof pushSubscriptionSchema>;
            if (sub.endpoint === endpoint) {
              await redis.srem(userSubscriptionKey, subStr);
              removed = true;
              break;
            }
          } catch (parseError) {
            fastify.log.warn(`解析存储的订阅信息失败 (key: ${userSubscriptionKey}): ${subStr}`, parseError);
          }
        }
        if (removed) {
          return reply.send({ success: true, message: '取消订阅成功' });
        } else {
          return reply.code(404).send({ error: '未找到对应的订阅信息' });
        }
      } catch (error) {
        fastify.log.error('移除推送订阅失败:', error);
        return reply.code(500).send({ error: '取消订阅失败' });
      }
    }
  );

} 