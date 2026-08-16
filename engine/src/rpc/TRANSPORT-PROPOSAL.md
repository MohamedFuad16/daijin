# Attach transport: one daemon, many clients

Proposal, not built. Written 2026-08-16 for the leader's approval (D-0022).
Status of the client-side points: consulted with tui-builder, answers pending
where marked PENDING.

## Why

D-0019 ruled one daemon per state root, with multiple TUI instances served by
one daemon holding many clients. The daemon enforces the first half and cannot
deliver the second: stdio is parent-child, so a second client has no way to
reach a running daemon and spawns its own, which the lock then refuses.

store-adapter found what that looks like from the outside. The refusal writes
an actionable sentence to stderr naming the holding pid and the lock path;
`tui/daijin_tui/rpc.py:206` sets `stderr=DEVNULL`, so the second terminal gets
`ConnectionError("engine closed its stdout")` and nothing else. The installer
put a `daijin` shim on PATH, which turned "two terminals at once" from a
hypothetical into the ordinary first-week accident. The stderr half is
tui-builder's separate fix; this document is the real answer behind it.

## The shape

A second transport, a unix domain socket, alongside the existing stdio one.

```
<stateRoot>/daemon.sock     the socket
<stateRoot>/daemon.lock     the existing single-writer lock, unchanged
```

Client behavior becomes attach-if-running, spawn-if-not. The lock stops being
something a user meets: a second CLIENT attaches, and only a second DAEMON is
refused, which is what D-0019 meant.

Framing is unchanged: one JSON object per line, UTF-8, newline terminated. A
socket connection and a stdio pipe carry byte-identical traffic, which is what
lets one dispatcher serve both and one client class read both.

## MEASURED BLOCKER: the daemon cannot serve two clients today

This is the finding that decides the order of work, and it is measured rather
than predicted.

`EngineState` does read-modify-write on `repos.json` through a temp file named
`repos.json.tmp-${process.pid}`. That name is per PROCESS, not per write, so two
concurrent writes inside one daemon collide on the same temp path and one
`rename` fails outright:

```
2 concurrent attaches  -> 1 threw, repos.json holds 1 of 2   [hard error]
3 concurrent attaches  -> 2 threw, repos.json holds 1 of 3   [hard error]
5 concurrent attaches  -> 4 threw, repos.json holds 1 of 5   [hard error]
10 concurrent attaches -> 9 threw, repos.json holds 1 of 10  [hard error]
```

It fails at N=2, and it fails loudly rather than silently, which is the one
piece of luck in it.

NOT REACHABLE TODAY: the stdio loop awaits each request before reading the next,
so no two handlers ever run concurrently, and the detached jobs do not write
`EngineState` (consent uses append, gates discovery writes a repo file). So this
is not a live defect. It is a precondition: the first two attached clients hit
it immediately.

Required before any socket work:

1. Serialize state writes inside the daemon: one async mutex around
   read-modify-write, or a single-writer queue. The lock protects the file from
   another PROCESS; nothing today protects it from another CONNECTION.
2. Make the temp name unique per write, not per process.
3. A test that runs N concurrent mutations through the real state and asserts
   all N land. The numbers above are what that test should refuse to reproduce.

## Socket path and lifecycle

Path is `<stateRoot>/daemon.sock`, beside the lock, so the socket follows the
state it serves and an uninstall that leaves state alone leaves it alone too.

MEASURED CONSTRAINT: `sun_path` is 104 bytes on macOS. Binding a 170-byte path
fails with `EINVAL`; the real paths are well inside it (`~/.daijin/daemon.sock`
is 34 bytes, a `mkdtemp` test root 79). It still needs an explicit check with a
named error, because the failure mode is an unexplained `EINVAL` at startup and
a test harness with a deep temp path is exactly where it would first appear.

Lifecycle:

- The daemon takes the lock FIRST, then binds. Lock before socket, so two
  daemons can never both believe they own the state root.
- A stale socket from a crashed daemon is handled by the lock, not by guessing:
  if the lock is reclaimable the previous daemon is gone, so the stale socket
  file is unlinked and rebound. Connect-then-decide is not needed, and it would
  be racy.
- On clean exit the socket is unlinked with the lock released.

## Notification fan-out

Both channels go to every attached client:

- `step`: every event to every client, carrying the `jobId` it already carries.
  A second window showing an init running in the first is a feature, not noise;
  the alternative, routing events only to the connection that started the job,
  makes a second TUI show a frozen screen during the very work it should display.
- `boardFinding`: broadcast, as it already is not job scoped.

PENDING (tui-builder): whether any screen assumes every `step` event belongs to
a job it started. If one does, that assumption breaks here.

Per-connection state the daemon must keep separate:

- REQUEST IDS ARE PER CONNECTION. Clients number from 1 independently, so two
  clients both send id 1. Pending work is keyed by connection, never in one
  global map. Stated here so nobody later "fixes" it into global ids.
- Writes are shared and serialized (see the blocker above); reads are not.

## Daemon exit with clients attached

The daemon persists until explicitly stopped. It does NOT exit when the last
client detaches, because MCP serving and a gym cycle outlive any window.

On daemon exit, attached clients see the socket close. Proposed: surface "the
engine stopped" and do NOT auto-reconnect, because a silent respawn produces a
fresh daemon that knows nothing about the job the user was watching, and a feed
that resumes into a different process is worse than one that stops.

PENDING (tui-builder): whether an explicit user-initiated reconnect is wanted.

## The spawn race

Two clients starting at the same instant both find no socket and both spawn. The
loser's daemon exits on the lock; the loser's CLIENT retries the connect for a
bounded window and attaches to the winner. The race resolves itself and the user
sees a working session either way.

PENDING (tui-builder): the retry budget, sized to the TUI's first paint.

## Security posture

- Socket mode `0600`, and the state root `0700`. Same-user only; a unix socket
  with default permissions in a shared `/tmp` would be a local privilege
  boundary crossed by accident, which is why the socket lives in the state root
  rather than a temp directory.
- No authentication beyond filesystem permissions, which is the correct posture
  for a per-user daemon: anything that can read `~/.daijin` can already read the
  brain, the settings and the key POINTERS the socket would expose.
- The socket exposes the same surface as stdio and no more. In particular it
  does not become a remote surface: `AF_UNIX` only, never a TCP port, because a
  TCP daemon carrying a spend gate is a different security problem entirely.
- The daemon still never holds a key VALUE; `keyRef` remains a pointer, so a
  socket peer cannot read a secret the daemon does not have.

## stdio stays

Unchanged, and it stays the transport the tests use. Reasons, in order:

1. The hermetic suite drives a real process over a real pipe, which is what
   catches framing bugs a socket harness would inherit rather than test.
2. A dev running one daemon under a debugger wants a child process, not an
   attach.
3. `daijin --engine 'node .../daemon.js'` keeps working, so the installer's
   current shim is not invalidated by this proposal.

Selection: `--socket` binds and serves; its absence keeps today's behavior. No
mode is inferred, so a client cannot get the other transport by accident.

## Contract impact

None. Transport sits below the contract: same methods, same framing, same error
convention. `methods.md` would gain at most a v6 NOTE describing the connection
story, not a changed method.

One nuance worth writing into that note: with attach, `hello` is still the first
message each CLIENT sends, but no longer the first the DAEMON has seen. The
contract says "first call on connect", which is already per connection and stays
true. PENDING (tui-builder): whether any client logic depends on `hello` being
globally first.

## Work, in order

1. Serialize state writes and fix the temp-name collision, with the N-concurrent
   test. Required regardless of this proposal; it is a latent defect the moment
   anything runs two handlers at once.
2. Socket server behind `--socket`, with the path-length check.
3. Per-connection pending maps and fan-out to all subscribers.
4. Client `SocketRpcClient` with attach-if-running (tui-builder's side).
5. Installer shim keeps targeting `daemon.js`; no change expected.

Step 1 is worth doing whether or not the rest is approved.

## What this does not solve

The stderr-discard problem for the window where a client still spawns its own
daemon: a startup failure that happens BEFORE the socket exists still has
nowhere to surface. tui-builder's stderr fix is what covers that, and it remains
necessary after this lands, because a daemon that cannot start cannot be
attached to either.
