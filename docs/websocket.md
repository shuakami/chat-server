# WebSocket API 文档

## 连接

WebSocket 连接地址：`ws://your-domain/ws?roomId={roomId}&userId={userId}`

## 消息格式

所有消息都使用 JSON 格式，包含以下字段：

- `type`: 消息类型，可以是 'message'（普通消息）, 'system'（系统消息）, 'join'（加入消息）, 'leave'（离开消息）, 'error'（错误消息）
- `roomId`: 房间ID
- `userId`: 用户ID
- `content`: 消息内容
- `timestamp`: 时间戳（毫秒）
- `fileMeta`: （可选）文件元数据

## 消息操作

### 发送消息

```json
{
  "type": "message",
  "content": "消息内容",
  "fileMeta": {
    "fileName": "文件名",
    "fileSize": 1024,
    "mimeType": "application/octet-stream"
  }
}
```

### 修改消息

只能修改自己发送的消息。

```json
{
  "action": "edit",
  "messageId": "消息ID",
  "content": "新的消息内容",
  "fileMeta": {
    "fileName": "文件名",
    "fileSize": 1024,
    "mimeType": "application/octet-stream"
  }
}
```

修改成功后，服务器会广播一条系统消息：

```json
{
  "type": "system",
  "content": {
    "action": "edit",
    "messageId": "消息ID",
    "newMessage": {
      "type": "message",
      "roomId": "房间ID",
      "userId": "用户ID",
      "content": "新的消息内容",
      "timestamp": 1234567890,
      "fileMeta": {
        "fileName": "文件名",
        "fileSize": 1024,
        "mimeType": "application/octet-stream"
      }
    }
  }
}
```

### 删除消息

只能删除自己发送的消息。

```json
{
  "action": "delete",
  "messageId": "消息ID"
}
```

删除成功后，服务器会广播一条系统消息：

```json
{
  "type": "system",
  "content": {
    "action": "delete",
    "messageId": "消息ID"
  }
}
```

## 错误处理

当操作失败时，服务器会返回一条错误消息：

```json
{
  "type": "error",
  "content": "错误信息"
}
```

常见错误：
- 消息ID和内容不能为空
- 消息ID不能为空
- 修改消息失败
- 删除消息失败
- 没有权限修改/删除该消息 