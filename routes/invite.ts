import { FastifyInstance } from 'fastify';
import { Resend } from 'resend';
import { config } from '../config/env';

// 创建Resend实例
const resend = new Resend(config.resend.apiKey);

// 频率限制配置
const RATE_LIMIT = {
  WINDOW_MS: 3600000, // 1小时时间窗口
  MAX_REQUESTS: 10,   // 每个IP每小时最多10次请求
  CLEANUP_INTERVAL: 3600000 // 清理间隔：1小时
};

// 存储请求记录
interface RequestRecord {
  count: number;
  timestamps: number[];
  firstRequest: number;
}

const requestMap = new Map<string, RequestRecord>();

// 清理过期数据
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of requestMap.entries()) {
    if (now - record.firstRequest > RATE_LIMIT.WINDOW_MS) {
      requestMap.delete(ip);
    }
  }
}, RATE_LIMIT.CLEANUP_INTERVAL);

// 频率限制中间件
const rateLimiter = (ip: string): { allowed: boolean; remainingRequests: number; resetTime: number } => {
  const now = Date.now();
  
  // 获取或创建请求记录
  let record = requestMap.get(ip);
  if (!record) {
    record = {
      count: 0,
      timestamps: [],
      firstRequest: now
    };
    requestMap.set(ip, record);
  }

  // 清理过期的请求记录
  record.timestamps = record.timestamps.filter(time => now - time < RATE_LIMIT.WINDOW_MS);
  
  // 检查是否超出限制
  if (record.timestamps.length >= RATE_LIMIT.MAX_REQUESTS) {
    const oldestRequest = record.timestamps[0];
    const resetTime = oldestRequest + RATE_LIMIT.WINDOW_MS;
    return {
      allowed: false,
      remainingRequests: 0,
      resetTime
    };
  }

  // 更新请求记录
  record.timestamps.push(now);
  record.count++;

  return {
    allowed: true,
    remainingRequests: RATE_LIMIT.MAX_REQUESTS - record.timestamps.length,
    resetTime: now + RATE_LIMIT.WINDOW_MS
  };
};

// HTML邮件模板
const generateEmailTemplate = (inviterName: string, roomId: string) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Helvetica, Arial, sans-serif;
      margin: 0;
      padding: 0;
      background: #ffffff;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      color: #000000;
      line-height: 1.5;
    }
    .wrapper {
      width: 100%;
      background: #ffffff;
      padding: 68px 0;
    }
    .container {
      max-width: 460px;
      margin: 0 auto;
      padding: 0 20px;
    }
    .content {
      margin-bottom: 48px;
    }
    .logo {
      margin-bottom: 32px;
      font-size: 20px;
      font-weight: 500;
      color: #000000;
    }
    .title {
      font-size: 24px;
      font-weight: 500;
      color: #000000;
      margin: 0 0 6px 0;
      padding: 0;
      line-height: 1.3;
    }
    .description {
      font-size: 16px;
      color: #666666;
      margin: 0 0 32px 0;
      padding: 0;
      line-height: 1.6;
    }
    .button {
      display: inline-block;
      background: #000000;
      color: #ffffff;
      text-decoration: none;
      padding: 12px 24px;
      border-radius: 4px;
      font-size: 14px;
      font-weight: 500;
      margin: 0;
    }
    .notice {
      margin-top: 32px;
      padding: 24px;
      background: #f7f7f7;
      border-radius: 4px;
    }
    .notice-title {
      font-size: 14px;
      font-weight: 600;
      color: #000000;
      margin: 0 0 12px 0;
    }
    .notice-text {
      font-size: 14px;
      color: #666666;
      margin: 0;
      padding: 0;
      line-height: 1.6;
    }
    .notice-list {
      margin: 12px 0 0 0;
      padding: 0;
      list-style-type: none;
    }
    .notice-list li {
      position: relative;
      padding-left: 16px;
      margin: 8px 0;
      font-size: 14px;
      color: #666666;
      line-height: 1.5;
    }
    .notice-list li::before {
      content: "•";
      position: absolute;
      left: 0;
      color: #000000;
    }
    .footer {
      font-size: 13px;
      color: #999999;
      margin-top: 48px;
    }
    .divider {
      height: 1px;
      background: #eaeaea;
      margin: 24px 0;
    }
    .name {
      color: #000000;
      font-weight: 500;
    }
    @media (max-width: 480px) {
      .wrapper {
        padding: 48px 0;
      }
      .container {
        padding: 0 24px;
      }
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="content">
        <div class="logo">sdjz / chat</div>
        
        <h1 class="title">
          ${inviterName} 邀请你加入私密聊天
        </h1>
        
        <p class="description">
          点击下方按钮加入聊天室，开始私密对话。
        </p>

        <a href="https://chat.sdjz.wiki/room/${roomId}" class="button">
          加入聊天室
        </a>

        <div class="notice">
          <p class="notice-text">
            为了保护您的安全，请您务必注意以下事项：
          </p>
          <ul class="notice-list">
            <li>我们是一个开放的聊天平台，不会验证或保证任何用户的真实身份</li>
            <li>请确认邀请者 ${inviterName} 确实是您认识的人</li>
            <li>在聊天过程中，不要轻易相信他人提供的外部链接或二维码</li>
            <li>不要在聊天中透露您的个人敏感信息（如银行账号、密码等）</li>
            <li>如遇到可疑情况，请立即退出聊天室并联系我们的支持团队</li>
            <li>对于因用户身份无法确认而导致的任何损失，平台不承担责任</li>
          </ul>
        </div>
      </div>

      <div class="divider"></div>
      
      <div class="footer">
        此邮件由系统自动发送，请勿回复
        <br>
        Powered by sdjz / chat
      </div>
    </div>
  </div>
</body>
</html>
`;

// 路由定义
export default async function inviteRoutes(fastify: FastifyInstance) {
  fastify.post('/api/invite', async (request, reply) => {
    // 获取真实IP
    const ip = request.ip;
    
    // 检查频率限制
    const rateLimit = rateLimiter(ip);
    if (!rateLimit.allowed) {
      return reply.code(429).send({
        error: '请求过于频繁',
        remainingRequests: rateLimit.remainingRequests,
        resetTime: new Date(rateLimit.resetTime).toISOString()
      });
    }

    const { inviterName, recipientEmail, roomId } = request.body as {
      inviterName: string;
      recipientEmail: string;
      roomId: string;
    };

    try {
      // 验证邮箱格式
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(recipientEmail)) {
        return reply.code(400).send({
          error: '无效的邮箱地址'
        });
      }

      // 验证其他参数
      if (!inviterName || !roomId) {
        return reply.code(400).send({
          error: '缺少必要参数'
        });
      }

      // 发送邮件
      const { data, error } = await resend.emails.send({
        from: config.resend.fromEmail,
        to: recipientEmail,
        subject: `${inviterName} 邀请你加入聊天室`,
        html: generateEmailTemplate(inviterName, roomId),
      });

      if (error) {
        console.error('邮件发送失败:', error);
        return reply.code(500).send({
          error: '邮件发送失败'
        });
      }

      // 设置速率限制相关的响应头
      reply.header('X-RateLimit-Limit', RATE_LIMIT.MAX_REQUESTS);
      reply.header('X-RateLimit-Remaining', rateLimit.remainingRequests);
      reply.header('X-RateLimit-Reset', rateLimit.resetTime);

      return reply.send({
        success: true,
        message: '邀请邮件已发送',
        data,
        rateLimit: {
          remaining: rateLimit.remainingRequests,
          resetTime: new Date(rateLimit.resetTime).toISOString()
        }
      });
    } catch (err) {
      console.error('邮件发送出错:', err);
      return reply.code(500).send({
        error: '服务器内部错误'
      });
    }
  });
} 