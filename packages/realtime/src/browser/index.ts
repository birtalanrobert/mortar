/**
 * What a browser bundle imports: the wire format, the gap logic and the
 * client, and nothing of the server.
 *
 * The root exports the same three beside the server's backlog, publisher and
 * resume. Its output is CommonJS, which a bundler cannot tree-shake, so a
 * client importing the root ships the server's half to every phone that opens
 * it — dependency-free, and still bytes nobody runs. This entry is the root's
 * browser half alone.
 */
export { parseFrame, type ClientFrame, type RealtimeEvent, type ServerFrame } from '../wire';

export { ChannelCursor, missing } from '../gaps';

export {
  RealtimeClient,
  type ClientOptions,
  type ConnectionState,
  type SocketLike,
} from '../client';
