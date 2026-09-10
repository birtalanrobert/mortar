# @birtalanrobert/realtime

Channels with sequence numbers, gap detection, resume, bidirectional
heartbeats, and a polling fallback that is built and tested rather than
described.

Five of the seventeen products hold a live connection: a kitchen display, a
venue's staff app, and four game clients. What makes this a package rather than
`new WebSocket` in each of them is not the socket handling — it is **gap
detection**. A client that can say _"I last saw 412"_ and be told what it missed
is the difference between "probably fine" and "provably complete", and a
display that is quietly one ticket behind looks exactly like a kitchen with no
orders.

## The root is pure

Wire format, gap logic and the browser client. No framework, no Node, no
dependencies — four browser bundles import it. The server lives in the same
entry today because it is equally dependency-free; anything that needs Redis or
Nest arrives behind a subpath.

## The client

```ts
import { RealtimeClient } from '@birtalanrobert/realtime';

const client = new RealtimeClient({
  url: 'wss://api.example.com/realtime',
  pollUrl: 'https://api.example.com/realtime/poll',
  channels: ['station:grill'],
  onEvent: (event) => apply(event),
  onState: (state) => showConnection(state),
  onResync: () => reloadEverything(),
});

client.start();
```

Three behaviours are worth knowing before using it:

- **It resumes from where it stood.** A reconnection subscribes with the last
  sequence it saw in each channel, so the events that arrived while it was away
  are sent. Subscribing "from now" loses exactly the window a reconnection
  exists to cover.
- **Duplicates are normal.** A resume overlaps the live stream by design,
  because the alternative is a race in which the gap between "here is your
  backlog" and "you are now live" loses an event. `ChannelCursor` makes the
  overlap harmless.
- **`onResync` means reload.** The server could not replay far enough back and
  said so. A partial replay that looks complete is the failure this package
  exists to prevent, so the honest answer is for the product to fetch its own
  state again.

**Polling starts immediately** when a socket will not open, and the socket is
retried behind it. A venue whose network eats WebSockets — a hotel, a corporate
guest network, an ageing router — gets a working display rather than a spinner
and an exponential backoff. The fallback speaks the same protocol and is
answered by the same `resume`, which is what keeps it a fallback rather than a
second implementation that behaves differently on the day it is needed.

## The server

```ts
import { MemoryBacklog, RealtimePublisher, resume } from '@birtalanrobert/realtime';

const publisher = new RealtimePublisher({
  backlog: new MemoryBacklog(500),
  broadcast: (event) => redis.publish('realtime', JSON.stringify(event)),
});

await publisher.publish({ channel: 'station:grill', type: 'ticket.created', data: ticket });
```

`RealtimePublisher` is **the one place a sequence number is assigned**. A number
handed out twice is two events a client cannot tell apart; a number skipped is a
gap that will never be filled and makes every client reload for ever.

Publishing is _append then fan out_, in that order. A subscriber told about an
event before it was durable would learn about something a reconnecting client
could not be given — the same incompleteness, arriving through the door built to
prevent it.

An event arriving over the broadcast from another process goes through
`receiveBroadcast`, which does **not** append it: it already has its number.

`BacklogPort` is bounded on purpose. A backlog that grew for ever would be a
second database nobody chose; a bounded one can fail to answer, and saying so
out loud is what keeps a client honest. `MemoryBacklog` implements it for tests
and single-process deployments.

## The server half

`@birtalanrobert/realtime/nestjs` — a Redis backlog, a fan-out between gateway
processes, a polling handler and a Nest module. `ioredis` and `@nestjs/common`
are optional peers: a product that only holds a client pays for neither.

`@birtalanrobert/realtime/nestjs/socket` — the WebSocket server, and the only
thing here that needs `ws`. It is a separate entry point because importing a
barrel loads everything in it: a process that publishes and holds no sockets — a
worker releasing a timed event, say — would otherwise have to install a
WebSocket library to reach a Redis backlog.

```ts
import { RealtimeModule, RedisBacklog, RedisBroadcast } from '@birtalanrobert/realtime/nestjs';
import { RealtimeSocketServer } from '@birtalanrobert/realtime/nestjs/socket';

// In the module: the publisher, wired to a backlog the application built.
RealtimeModule.forRootAsync({
  inject: [ConfigModule.token(), RedisService],
  useFactory: (config, redis) => ({
    backlog: new RedisBacklog(redis.client, { prefix: config.QUEUE_PREFIX, keep: 500 }),
    broadcast: broadcast.send,
  }),
});

// In `main.ts`, where the HTTP server exists:
const server = new RealtimeSocketServer({ publisher, backlog, authorise });
server.attach(app.getHttpServer());
```

The socket server is **not** in the module on purpose: it needs the HTTP server
the application creates at bootstrap, and a module that tried to own that would
either guess at the ordering or hold a reference to something that does not
exist yet.

`RedisBacklog` assigns the number and stores the event in **one Lua script**.
Two round trips can come apart: a process that dies between `INCR` and `ZADD`
has handed out 413 and stored nothing, and no later care can fill that hole.

`RedisBroadcast` is fire-and-forget, which is acceptable here and nowhere else:
pub/sub does not deliver to a process that is not connected, but the event is
already durable, so a process that missed it serves it from the resume the
moment any client asks. The socket is the fast path; the backlog is the truth.

`authorise` returns the **subset** a caller may have rather than a boolean, so a
display asking for two stations it may see and one it may not gets the two —
rather than a connection that fails for a reason nobody can see.

For the polling route, `parsePollQuery` reads what the client sends and
`pollSince` answers it through the same `resume`.

## What this package does not do

Authorisation, acknowledgement, presence and moderation. Who may subscribe to
which channel is the product's decision; whether a ticket was _acted on_ is a
row in the product's database, not a frame on a socket. A transport that
believed it knew either would be wrong in a different way for each of the five
products that need it.
