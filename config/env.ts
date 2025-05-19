import fs from 'fs';
import path from 'path';

export interface Config {
  redis: {
    url: string;
    token: string;
  };
  jwt: {
    secret: string;
  };
  room: {
    ttl: number;
    maxMessages: number;      // 每个房间最大消息数
    inactiveTtl: number;     // 房间不活跃超时时间（秒）
    cleanupInterval: number; // 清理任务执行间隔（秒）
  };
  isProduction: boolean;
  dogecloud: {
    accessKey: string;
    secretKey: string;
    bucket: string;
  };
  resend: {
    apiKey: string;
    fromEmail: string;
  };
  vapid: {
    publicKey: string;
    privateKey: string;
    subject: string; // mailto: address or URL
  };
  agoraAppId: string;
  agoraAppCertificate: string;
}

let loadedConfig: Config;

try {
  const configPath = path.resolve(process.cwd(), 'config.json');
  if (!fs.existsSync(configPath)) {
    console.error(`错误：配置文件 config.json 未在路径 ${configPath} 中找到。`);
    console.error("请根据 config/env.ts 中的 Config 接口创建一个 config.json 文件。");
    console.error("您可以使用以下模板作为起点：");
    console.error(`
{
  "redis": {
    "url": "redis://localhost:6379",
    "token": ""
  },
  "jwt": {
    "secret": "your-secret-key"
  },
  "room": {
    "ttl": 86400,
    "maxMessages": 5000,
    "inactiveTtl": 2592000,
    "cleanupInterval": 86400
  },
  "isProduction": false,
  "dogecloud": {
    "accessKey": "",
    "secretKey": "",
    "bucket": ""
  },
  "resend": {
    "apiKey": "re_",
    "fromEmail": "noreply@email.sdjz.wiki"
  },
  "vapid": {
    "publicKey": "",
    "privateKey": "",
    "subject": ""
  },
  "agoraAppId": "",
  "agoraAppCertificate": ""
}
    `);
    process.exit(1);
  }
  const configFile = fs.readFileSync(configPath, 'utf-8');
  loadedConfig = JSON.parse(configFile) as Config;

} catch (error) {
  console.error("加载配置文件 config.json 时出错:", error);
  process.exit(1);
}

export const config: Config = loadedConfig;  