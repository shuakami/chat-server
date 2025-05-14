# Sdjz / Chat API Document

## 目录

- [WebSocket API](#websocket-api)
  - [连接](#连接)
  - [消息发送](#消息发送)
  - [消息格式](#消息格式)
  - [事件类型](#事件类型)
- [HTTP API](#http-api)
  - [历史消息](#历史消息)
  - [文件上传/下载](#文件上传下载)
- [Emoji API](#emoji-api)
  - [获取所有表情包](#获取所有表情包)
  - [获取指定表情包](#获取指定表情包)
  - [搜索表情包](#搜索表情包)
  - [分页获取表情包](#分页获取表情包)

## WebSocket API

前端这里 `your-domain` 应该在env定义。

### 连接

**WebSocket 连接地址**：`ws://your-domain/ws`

**连接参数**：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| roomId | string | 是 | 房间ID |
| userId | string | 是 | 用户ID |

**示例**：
```javascript
const ws = new WebSocket('ws://your-domain/ws?roomId=room1&userId=user1');
```

### 消息发送

消息在服务器端自动加密存储，客户端只需发送普通消息。

**发送文本消息**：
```javascript
ws.send(JSON.stringify({
  type: 'message',
  content: '你好，世界！'
}));
```

**发送Markdown消息**：
```javascript
ws.send(JSON.stringify({
  type: 'message',
  content: '# 标题\n这是一段**加粗**的文字'
}));
```

### 接收消息

```javascript
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  console.log('收到消息:', message.content);
};

// 处理连接关闭
ws.onclose = () => {
  console.log('连接已关闭');
};

// 处理错误
ws.onerror = (error) => {
  console.error('WebSocket错误:', error);
};
```

### 消息格式

**发送消息格式**：
```typescript
interface SendMessage {
  type: 'message';
  content: string;
  fileMeta?: {
    fileName: string;
    fileSize: number;
    mimeType: string;
  };
}
```

**接收消息格式**：
```typescript
interface ReceiveMessage {
  type: 'message' | 'system' | 'join' | 'leave' | 'error' | 'delete' | 'edit' | 'onlineList';
  roomId: string;
  userId: string;
  content: string;
  timestamp: number;
  fileMeta?: {
    fileName: string;
    fileSize: number;
    mimeType: string;
  };
  messageId?: string;  // 用于编辑和删除操作
}
```

### 事件类型

| 事件类型 | 说明 |
|----------|------|
| message | 普通消息 |
| system | 系统消息 |
| join | 用户加入房间 |
| leave | 用户离开房间 |
| error | 错误消息 |
| delete | 删除消息 |
| edit | 编辑消息 |
| onlineList | 在线用户列表更新 |

**在线用户列表消息格式**：
```typescript
interface OnlineListMessage {
  type: 'onlineList';
  roomId: string;
  userId: 'system';
  content: string; // JSON.stringify(string[]) - 在线用户ID数组
  timestamp: number;
}
```

**示例**：
```javascript
// 处理在线用户列表更新
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.type === 'onlineList') {
    const onlineUsers = JSON.parse(message.content);
    console.log('当前在线用户:', onlineUsers);
  }
};
```

## HTTP API

### 历史消息

**获取历史消息**：
```
GET /api/history?room={roomId}&from={timestamp}&to={timestamp}&limit={number}
```

**参数说明**：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| room | string | 是 | 房间ID |
| from | number | 否 | 起始时间戳（毫秒） |
| to | number | 否 | 结束时间戳（毫秒） |
| limit | number | 否 | 返回消息数量限制 |

**响应格式**：
```typescript
interface HistoryResponse {
  messages: {
    id: string;
    type: 'message' | 'system' | 'join' | 'leave' | 'error';
    roomId: string;
    userId: string;
    content: string;
    timestamp: number;
    fileMeta?: {
      fileName: string;
      fileSize: number;
      mimeType: string;
    };
  }[];
}
```

**获取最新消息**：
```
GET /api/history/latest?room={roomId}&limit={number}
```

**参数说明**：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| room | string | 是 | 房间ID |
| limit | number | 否 | 返回消息数量限制 |

### 文件上传/下载

**文件上传**：
```
POST /api/upload
Content-Type: multipart/form-data
```

**参数说明**：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| file | File | 是 | 要上传的文件 |
| roomId | string | 是 | 房间ID |

**响应格式**：
```typescript
interface UploadResponse {
  url: string;
  fileMeta: {
    fileName: string;
    fileSize: number;
    mimeType: string;
  };
}
```

**文件下载**：
```
GET /api/files/{fileId}
```

## Emoji API

### 获取所有表情包

获取所有可用的表情包列表。

```
GET /api/emoji
```

**响应格式**：
```typescript
interface EmojiResponse {
  emojis: {
    [key: string]: {
      summary: string;      // 表情包描述
      file: string;        // 文件名
      url: string;         // 表情包URL
      emoji_id: string;    // 表情包ID
      emoji_package_id: number; // 表情包包ID
      timestamp: number;   // 时间戳
    }
  }
}
```

### 获取指定表情包

获取指定ID的表情包信息。

```
GET /api/emoji/:id
```

**参数说明**：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| id | string | 是 | 表情包ID |

**响应格式**：
```typescript
interface SingleEmojiResponse {
  summary: string;      // 表情包描述
  file: string;        // 文件名
  url: string;         // 表情包URL
  emoji_id: string;    // 表情包ID
  emoji_package_id: number; // 表情包包ID
  timestamp: number;   // 时间戳
}
```

### 搜索表情包

根据关键词搜索表情包。

```
GET /api/emoji/search?keyword={keyword}
```

**参数说明**：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| keyword | string | 是 | 搜索关键词 |

**响应格式**：
```typescript
interface SearchEmojiResponse {
  emojis: {
    [key: string]: {
      summary: string;      // 表情包描述
      file: string;        // 文件名
      url: string;         // 表情包URL
      emoji_id: string;    // 表情包ID
      emoji_package_id: number; // 表情包包ID
      timestamp: number;   // 时间戳
    }
  }
}
```

### 分页获取表情包

分页获取表情包列表。

```
GET /api/emoji/page/:page
```

**参数说明**：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| page | number | 是 | 页码（从1开始） |

**响应格式**：
```typescript
interface PageEmojiResponse {
  emojis: {
    [key: string]: {
      summary: string;      // 表情包描述
      file: string;        // 文件名
      url: string;         // 表情包URL
      emoji_id: string;    // 表情包ID
      emoji_package_id: number; // 表情包包ID
      timestamp: number;   // 时间戳
    }
  },
  total: number;           // 总表情包数量
  pageSize: number;        // 每页大小
  currentPage: number;     // 当前页码
  totalPages: number;      // 总页数
}
```

## 错误处理

所有API在发生错误时会返回以下格式：

```typescript
{
  error: string       // 错误信息
}
```

常见HTTP状态码：
- 400：请求参数错误
- 404：资源不存在
- 500：服务器内部错误

## 安全说明

1. 所有消息在服务器端自动加密存储
2. 客户端无需处理加密/解密逻辑
3. 每个房间使用独立的加密密钥
4. 文件内容也会被加密存储

## 配置参数

系统关键配置参数：

```typescript
{
  room: {
    ttl: 86400,           // 房间生存时间（秒）
    maxMessages: 5000,    // 每个房间最大消息数
    inactiveTtl: 2592000, // 房间不活跃超时时间（秒）
    cleanupInterval: 86400 // 清理任务执行间隔（秒）
  }
}
``` 