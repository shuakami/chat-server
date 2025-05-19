export interface AgoraTokenRequest {
  channelName: string; // 对应聊天室的 roomId
  userId: string; // UserId
}

export interface AgoraTokenResponse {
  token: string;
  agoraUid: number; // 声网服务实际使用的数字 UID
  appId: string; // 声网 App ID，方便前端直接使用
}

// 用于 WebSocket 广播的语音状态更新消息
export interface VoiceChannelStateMessage {
  type: 'voice-channel-state';
  roomId: string;
  userId: string;       // 用户的原始 ID
  agoraUid: number;     // 用户在 Agora 中的 UID
  action: 'user-joined-voice' | 'user-left-voice' | 'user-muted-audio' | 'user-unmuted-audio';
  displayName?: string; // 用户昵称 (可选,方便前端显示)
  timestamp: number;
}

// 前端成功执行声网操作后，通知后端的动作消息
export interface VoiceChannelActionMessage {
  type: 'voice-channel-action';
  roomId: string; // 确保是当前房间的操作
  userId: string; // 发起动作的用户ID，后端会校验是否与ws.userId一致
  agoraUid: number; // 该用户在声网的UID，前端加入频道成功后获得
  action: 'notify-joined' | 'notify-left' | 'notify-muted' | 'notify-unmuted';
  // payload?: any; // 可选的额外数据，例如静音的是音频还是视频等
} 