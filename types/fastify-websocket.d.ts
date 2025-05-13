import { WebSocket } from 'ws';
import { FastifyRequest, FastifyInstance } from 'fastify';

declare module '@fastify/websocket' {
  export interface SocketStream {
    socket: WebSocket;
  }

  export interface WebsocketHandler {
    (socket: WebSocket, request: FastifyRequest): void | Promise<void>;
  }

  export interface WebsocketRouteOptions {
    websocket: true;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    get(path: string, opts: { websocket: true }, handler: WebsocketHandler): FastifyInstance;
  }
} 