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

## What this package does not do

Authorisation, acknowledgement, presence and moderation. Who may subscribe to
which channel is the product's decision; whether a ticket was _acted on_ is a
row in the product's database, not a frame on a socket. A transport that
believed it knew either would be wrong in a different way for each of the five
products that need it.
