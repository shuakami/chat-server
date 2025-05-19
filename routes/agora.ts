import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { RtcTokenBuilder, RtcRole } from 'agora-token';
import { config } from '../config/env';
import { AgoraTokenRequest, AgoraTokenResponse } from '../types/agora';

const TOKEN_EXPIRATION_TIME_IN_SECONDS = 3600; // Token 有效期1小时

// 简单的字符串到数字 UID 的映射 (确保在App ID范围内唯一性，或根据业务调整)
// 声网要求 UID 为 32 位无符号整数，范围是 1 到 (2^32-1)。这里做了简化处理。
function mapUserIdToAgoraUid(userId: string, channelName: string): number {
  let hash = 0;
  const str = userId;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit integer
  }
  // 将结果转换为无符号32位整数，并确保不为0
  const uid = (hash >>> 0) % (Math.pow(2, 32) -1) + 1;
  return uid > 2000000000 ? uid - 1000000000: uid; 
}

export default async function agoraRoutes(fastify: FastifyInstance) {
  fastify.post('/api/agora/token', async (request: FastifyRequest<{ Body: AgoraTokenRequest }>, reply: FastifyReply) => {
    let userIdFromRequest = request.body.userId; 

    // 优先从认证过的会话中获取 userId，如果存在
    const authenticatedUserId = (request as any).user?.id;
    if (authenticatedUserId) {
        userIdFromRequest = authenticatedUserId;
    }

    if (!userIdFromRequest) {
        fastify.log.warn('User ID not found in request body or authenticated session for Agora token generation.');
        // 生产环境应返回错误，此处为演示目的，可以生成一个临时ID或拒绝
        return reply.status(400).send({ error: 'User ID is required for token generation.' });
    }

    const { channelName } = request.body;

    if (!config.agoraAppId || !config.agoraAppCertificate) {
      fastify.log.error('Agora App ID or App Certificate is not configured in config.json.');
      return reply.status(500).send({ error: 'Voice service configuration error. Please contact administrator.' });
    }

    if (!channelName) {
      return reply.status(400).send({ error: 'Channel name (channelName) is required in the request body.' });
    }

    // 生成一个用于声网的数字UID
    const agoraUid = mapUserIdToAgoraUid(userIdFromRequest, channelName);

    const role = RtcRole.PUBLISHER; // 允许发布音视频流
    const privilegeExpireTime = Math.floor(Date.now() / 1000) + TOKEN_EXPIRATION_TIME_IN_SECONDS;

    try {
      fastify.log.info(`Generating Agora token for channel: ${channelName}, user: ${userIdFromRequest}, agoraUid: ${agoraUid}`);
      const token = RtcTokenBuilder.buildTokenWithUid(
        config.agoraAppId,
        config.agoraAppCertificate,
        channelName,
        agoraUid, 
        role,
        privilegeExpireTime,
        privilegeExpireTime // Added tokenPrivilegeExpiredTs, same as privilegeExpiredTs
      );

      const response: AgoraTokenResponse = {
        token,
        agoraUid,
        appId: config.agoraAppId,
      };
      reply.send(response);

    } catch (error) {
      fastify.log.error(`Error generating Agora token for channel ${channelName}, user ${userIdFromRequest}:`, error);
      reply.status(500).send({ error: 'Failed to generate voice service token.' });
    }
  });
} 