import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { FileMeta } from '../types/websocket';
import { Readable } from 'stream';

interface OSSConfig {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  endpoint: string;
  bucket: string;
  region?: string;
}

export class OSSManager {
  private client: S3Client;
  private bucket: string;
  private endpoint: string;

  constructor(config: OSSConfig) {
    this.client = new S3Client({
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        sessionToken: config.sessionToken
      },
      endpoint: config.endpoint,
      region: config.region || 'auto'
    });
    this.bucket = config.bucket;
    this.endpoint = config.endpoint;
  }

  /**
   * 上传文件
   * @param key 文件路径
   * @param data 文件数据
   */
  async uploadFile(
    key: string,
    data: Buffer | Readable
  ): Promise<{ url: string; meta: FileMeta }> {
    // 将文件数据转换为Buffer
    let fileBuffer: Buffer;
    if (Buffer.isBuffer(data)) {
      fileBuffer = data;
    } else {
      fileBuffer = await this.streamToBuffer(data);
    }
    
    console.log(`[OSS] 准备上传文件: ${key}, 大小: ${fileBuffer.length} 字节`);

    // 构建文件元数据
    const meta: FileMeta = {
      fileName: key.split('/').pop() || key,
      fileSize: fileBuffer.length,
      mimeType: this.getMimeType(key)
    };
    
    console.log(`[OSS] 文件元数据: `, {
      fileName: meta.fileName,
      fileSize: meta.fileSize,
      mimeType: meta.mimeType
    });

    // 上传文件
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: fileBuffer,
        ContentType: meta.mimeType
      }));
      
      console.log(`[OSS] 文件上传成功: ${key}`);
    } catch (error) {
      console.error(`[OSS] 文件上传失败: ${key}`, error);
      throw error;
    }

    // 返回文件URL和元数据
    const result = {
      url: `https://sync.luoxiaohei.sdjz.wiki/${key}`,
      meta
    };
    
    console.log(`[OSS] 上传完成，返回结果:`, {
      url: result.url,
      fileName: result.meta.fileName,
      mimeType: result.meta.mimeType
    });
    
    return result;
  }

  /**
   * 下载文件
   * @param key 文件路径
   */
  async downloadFile(key: string): Promise<{ data: Buffer; meta: FileMeta }> {
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key
      }));

      const data = await this.streamToBuffer(response.Body as Readable);
      
      // 构建文件元数据
      const meta: FileMeta = {
        fileName: key.split('/').pop() || key,
        fileSize: data.length,
        mimeType: response.ContentType || this.getMimeType(key)
      };

      return { data, meta };
    } catch (error) {
      console.error(`[OSS] 下载文件失败: ${key}`, error);
      throw error;
    }
  }

  /**
   * 删除文件
   * @param key 文件路径
   */
  async deleteFile(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key
    }));
  }

  /**
   * 将Stream转换为Buffer
   */
  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('error', (err) => reject(err));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  /**
   * 根据文件名获取MIME类型
   */
  private getMimeType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    const mimeTypes: { [key: string]: string } = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'mp4': 'video/mp4',
      'mp3': 'audio/mpeg',
      'wav': 'audio/wav',
      'pdf': 'application/pdf',
      'doc': 'application/msword',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'xls': 'application/vnd.ms-excel',
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'zip': 'application/zip',
      'rar': 'application/x-rar-compressed',
      'txt': 'text/plain'
    };
    return mimeTypes[ext || ''] || 'application/octet-stream';
  }
}