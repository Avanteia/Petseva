import { Logger, Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, OnGatewayInit, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { EventsService } from '../common/events.service';

/**
 * Socket.IO gateway. Clients connect with `auth: { token }` and are joined to their outlet room.
 * All domain events are broadcast as `event` with the DomainEvent payload (POS, KDS, captain app share it).
 */
@WebSocketGateway({ cors: { origin: (process.env.CORS_ORIGIN ?? '*').split(',') }, path: '/ws' })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  @WebSocketServer() server: Server;
  private readonly log = new Logger('Realtime');

  constructor(
    private readonly events: EventsService,
    private readonly jwt: JwtService,
  ) {}

  afterInit() {
    this.events.subscribe((evt) => {
      this.server.to(`outlet:${evt.outletId}`).emit('event', evt);
    });
  }

  async handleConnection(client: Socket) {
    try {
      const token = (client.handshake.auth?.token as string) ?? (client.handshake.query?.token as string);
      const payload = await this.jwt.verifyAsync(token);
      client.join(`outlet:${payload.outletId}`);
      client.data.user = payload;
      client.emit('ready', { outletId: payload.outletId });
    } catch {
      client.emit('error', 'unauthorized');
      client.disconnect(true);
    }
  }
}

@Module({ providers: [RealtimeGateway] })
export class RealtimeModule {}
