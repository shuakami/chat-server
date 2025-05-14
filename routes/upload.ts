import { FastifyInstance } from 'fastify';
import { RoomManager } from '../utils/room';
import { OSSManager } from '../utils/oss';
import { CryptoManager } from '../utils/crypto';
import { config } from '../config/env';
import Busboy from 'busboy';
import type { FileInfo } from 'busboy';
import { Readable } from 'stream';
import crypto from 'crypto';

// 初始化OSS管理器
let ossManager: OSSManager | null = null;

function generateDogeCloudToken(path: string, body: string): string {
  const signStr = path + "\n" + body;
  const sign = crypto
    .createHmac('sha1', config.dogecloud.secretKey)
    .update(Buffer.from(signStr, 'utf8'))
    .digest('hex');
  return 'TOKEN ' + config.dogecloud.accessKey + ':' + sign;
}

async function initOSSManager() {
  try {
    if (!config.dogecloud.bucket) {
      throw new Error('DOGECLOUD_BUCKET 环境变量未配置');
    }

    const requestPath = '/auth/tmp_token.json';
    const requestBody = JSON.stringify({
      channel: 'OSS_FULL',
      scopes: [`${config.dogecloud.bucket}:*`]
    });

    // 调用多吉云API获取临时密钥
    const response = await fetch('https://api.dogecloud.com' + requestPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': generateDogeCloudToken(requestPath, requestBody)
      },
      body: requestBody
    });

    const data = await response.json();
    if (data.code !== 200) {
      throw new Error(data.msg);
    }

    // 初始化OSS管理器
    ossManager = new OSSManager({
      accessKeyId: data.data.Credentials.accessKeyId,
      secretAccessKey: data.data.Credentials.secretAccessKey,
      sessionToken: data.data.Credentials.sessionToken,
      endpoint: data.data.Buckets[0].s3Endpoint,
      bucket: data.data.Buckets[0].s3Bucket
    });
  } catch (err) {
    console.error('初始化OSS管理器失败:', err);
    throw err;
  }
}

export default async function uploadRoutes(fastify: FastifyInstance) {
  // 添加 multipart/form-data 的 content-type parser
  fastify.addContentTypeParser('multipart/form-data', (request, payload, done) => {
    done(null);
  });

  // 文件上传路由
  fastify.post('/api/upload', async (request, reply) => {
    return new Promise((resolve, reject) => {
      console.log('[Upload] 开始处理文件上传请求');
      console.log('[Upload] 请求头:', request.headers);

      const timeout = setTimeout(() => {
        console.log('[Upload] 请求超时');
        resolve(reply.code(408).send({ error: '请求超时' }));
      }, 30000);

      let fileData: Buffer | null = null;
      let fileName: string | null = null;
      let roomId: string | null = null;
      let mimeType: string | null = null;

      const busboy = Busboy({ headers: request.headers });

      busboy.on('file', (fieldname: string, file: NodeJS.ReadableStream, info: FileInfo) => {
        console.log('[Upload] 接收到文件:', {
          fieldname,
          filename: info.filename,
          mimeType: info.mimeType
        });

        if (fieldname === 'file') {
          fileName = info.filename;
          mimeType = info.mimeType;
          const chunks: Buffer[] = [];

          file.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });

          file.on('end', () => {
            fileData = Buffer.concat(chunks);
            console.log('[Upload] 文件接收完成:', {
              size: fileData.length
            });
          });
        }
      });

      busboy.on('field', (fieldname: string, value: string) => {
        console.log('[Upload] 接收到字段:', { fieldname, value });
        if (fieldname === 'roomId') {
          roomId = value;
        }
      });

      busboy.on('finish', async () => {
        clearTimeout(timeout);
        console.log('[Upload] 所有数据接收完成');

        try {
          if (!fileData || !fileName) {
            return resolve(reply.code(400).send({
              error: '未找到上传的文件'
            }));
          }

          if (!roomId) {
            return resolve(reply.code(400).send({
          error: '缺少房间ID'
            }));
      }

      // 确保OSS管理器已初始化
      if (!ossManager) {
            console.log('[Upload] 初始化OSS管理器');
            try {
        await initOSSManager();
            } catch (err) {
              console.error('[Upload] 初始化OSS管理器失败:', err);
              return resolve(reply.code(500).send({
                error: 'OSS初始化失败'
              }));
            }
          }

      // 生成文件路径
      const timestamp = Date.now();
          const filePath = `${roomId}/${timestamp}_${fileName}`;
          
          console.log('[Upload] 准备上传文件:', {
            filePath,
            filename: fileName,
            size: fileData.length
          });

          try {
            const { url, meta } = await (ossManager as OSSManager).uploadFile(
        filePath,
              fileData
            );

            console.log('[Upload] 文件上传成功:', {
              url,
              filename: meta.fileName,
              size: meta.fileSize
            });

            resolve(reply.send({
        url,
        meta
            }));
          } catch (err) {
            console.error('[Upload] 上传文件到OSS失败:', err);
            resolve(reply.code(500).send({
              error: '文件上传失败'
            }));
          }
    } catch (err) {
          console.error('[Upload] 处理上传请求失败:', err);
          resolve(reply.code(500).send({
        error: '文件上传失败'
          }));
    }
      });

      busboy.on('error', (err: Error) => {
        console.error('[Upload] 解析上传数据失败:', err);
        clearTimeout(timeout);
        resolve(reply.code(400).send({
          error: '解析上传数据失败'
        }));
      });

      request.raw.pipe(busboy);
    });
  });

  // 文件下载路由
  fastify.get('/api/download/:room/:key', {
    schema: {
      params: {
        type: 'object',
        required: ['room', 'key'],
        properties: {
          room: { type: 'string' },
          key: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { room, key } = request.params as { room: string; key: string };

      // 确保OSS管理器已初始化
      if (!ossManager) {
        await initOSSManager();
      }

      // 下载文件
      if (!ossManager) {
        throw new Error('OSS管理器未初始化');
      }

      const { data, meta } = await ossManager.downloadFile(
        `${room}/${key}`
      );

      // 设置响应头
      reply.header('Content-Type', meta.mimeType);
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(meta.fileName)}"`);

      return data;
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({
        error: '文件下载失败'
      });
    }
  });
} 