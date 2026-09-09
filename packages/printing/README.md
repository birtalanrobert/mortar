# @birtalanrobert/printing

ESC/POS rendering, a network transport, a retrying queue that escalates, and a
printer that keeps what it was sent so a product can test its own tickets.

Three products need paper. A kitchen in project 11 — where it is a **v1
requirement**, because a meaningful share of prospects will not buy without it —
a repair shop's intake receipt in project 12, and a box office's ticket stock in
project 01. What is shared is the byte-level rendering and the delivery
guarantee. What stays in each product is the **layout**, which is domain content
and shares nothing between a kitchen ticket and a repair receipt.

## A ticket

```ts
import { Ticket } from '@birtalanrobert/printing';

const bytes = new Ticket({ width: 42 })
  .heading('TABLE 7')
  .rule()
  .bold('2× Mici de casă')
  .line('   fără ceapă')
  .columns('Ciorbă de burtă', '24,50')
  .cut()
  .render();
```

Four mistakes it makes impossible, each of which has printed wrong in somebody's
kitchen:

- **The printer is initialised first.** It holds whatever the last ticket left
  it in, and the classic symptom is every ticket after a heading printing double
  height until somebody power-cycles it.
- **Every style is turned off again**, for the same reason.
- **`cut()` feeds the paper past the blade first.** The blade sits a couple of
  centimetres above the print head, so a cut without a feed takes the last three
  lines with it — on a kitchen ticket, the last three items.
- **Accented text is encoded for the printer's own character table**, defaulting
  to Windows-1250. `Ciorb? de burt?` is a ticket a cook misreads at a glance,
  and the American table most printers boot into produces exactly that.

Text **wraps** rather than truncating: the end of a line on a kitchen ticket is
where the modifiers are.

## Getting it there

```ts
import { NetworkPrinter, PrintQueue } from '@birtalanrobert/printing';

const queue = new PrintQueue({
  transportFor: (name) => printers.get(name),
  onFailure: (job, reason) => tellSomebody(job, reason),
});

await queue.print({ id, printer: 'grill', bytes, describedAs: 'table 7, grill' });
```

`NetworkPrinter` speaks raw port 9100, which every ESC/POS device in a kitchen
listens on. One connection per job: a thermal printer is a single-threaded
device, and holding a socket open across jobs loses the one thing that matters —
knowing, per ticket, whether the bytes reached it.

**`send` resolving means the bytes left this machine, and nothing more.** The
protocol has no acknowledgement, so a product reading "printed" as "on paper" is
reading something this protocol never says. Whether a _ticket_ was acted on is a
row in the product's database.

`PrintQueue` retries three times with a backoff, prints serially per queue —
two jobs at once interleave into one ticket with half of each on it — and
**escalates**. `onFailure` is not decoration: a queue that swallows a failure is
a kitchen with no ticket that never learns it has none, and the first anybody
knows is a guest asking where their food is.

Deliberately **not** BullMQ. A print job is worthless a minute after it was
created, so it belongs in memory beside the process that made it, retried for
seconds and then escalated to a person. Durability across a restart would be the
wrong promise: what a kitchen needs after one is the _current_ tickets, which
the display and the database already have.

A printer that does not exist fails immediately rather than after three
attempts — a configuration mistake gives the same answer every time, and six
seconds of retrying only delays it.

## Testing

`MemoryPrinter` implements the transport, keeps what it was sent, and can be
broken and fixed, because the behaviour worth testing is what happens when a
printer is unwell. It is exported rather than kept beside these tests because
every product that consumes this package needs a way to assert what a ticket
contained without owning a printer.
