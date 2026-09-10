/*
 * The publisher half of the server side: a backlog, a fan-out, a poll handler
 * and the Nest module.
 *
 * **`RealtimeSocketServer` is deliberately not here.** It is the only thing in
 * this package that needs `ws`, and importing a barrel loads everything in it —
 * so a process that publishes and holds no sockets (a worker releasing a timed
 * event, say) was made to install a WebSocket library to reach a Redis backlog,
 * which is precisely what the optional peer dependency was declared to avoid.
 * It lives at `@birtalanrobert/realtime/nestjs/socket`.
 */
export { RedisBacklog, type RedisBacklogOptions } from './redis-backlog';
export { RedisBroadcast } from './redis-broadcast';
export { pollSince, parsePollQuery } from './polling';
export {
  MORTAR_REALTIME_BACKLOG,
  RealtimeModule,
  type RealtimeModuleAsyncOptions,
  type RealtimeModuleOptions,
} from './realtime.module';
