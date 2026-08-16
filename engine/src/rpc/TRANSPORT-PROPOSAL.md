# Attach transport: one daemon, many clients

APPROVED as designed (leader, 2026-08-16, D-0022). All six client-side questions
answered by tui-builder; no PENDINGs remain. Scope of this build: the socket
SERVER and this document. `SocketRpcClient` is tui-builder's, written over its
existing `RpcClient` base so the notification dispatch is shared and the two
transports cannot drift.

Q3 is worth reading before the design: asking it found a real latent bug in the
client rather than confirming an assumption. See "Notification fan-out".

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

ANSWERED (tui-builder), and the answer was a bug rather than a confirmation.
Its screens filtered with `if self.job_id and event["jobId"] != self.job_id`.
Read the `and`: a screen that has started NO job has `self.job_id` set to None,
the condition is false, and the screen renders EVERY event it receives.
Demonstrated on the tree before it changed anything, feeding one foreign event
to an idle init screen: the screen adopted `job-init-9999`, advanced its
checklist, and would have announced "Init complete" for a job it never started,
against a repo that job never touched.

Unreachable under stdio, because a client only ever receives its own daemon's
events. Ordinary under a shared daemon. It is fixed on the client side now
(strict match, foreign job ids recorded rather than dropped so a screen can know
a job runs elsewhere without claiming it, mutation-verified), so broadcast is
safe to build as designed.

Two consequences for this side:

- `jobId` is MANDATORY on every step event, including the first. It is the only
  key the client filter has.
- "a second window shows the first's init" is NOT a feature we get from
  broadcast, and tui-builder explicitly does not want it implicitly: a useful
  version has to say whose job it is and against which repo. Recorded and
  ignored for now, a design conversation later.

Per-connection state the daemon must keep separate:

- REQUEST IDS ARE PER CONNECTION. Clients number from 1 independently, so two
  clients both send id 1. Pending work is keyed by connection, never in one
  global map. Stated here so nobody later "fixes" it into global ids.
- Writes are shared and serialized (see the blocker above); reads are not.

## Daemon exit with clients attached

The daemon persists until explicitly stopped. It does NOT exit when the last
client detaches, because MCP serving and a gym cycle outlive any window.

On daemon exit, attached clients see the socket close, surface "the engine
stopped", and do NOT auto-reconnect: a silent respawn produces a fresh daemon
that knows nothing about the job the user was watching, so the user would be
shown an empty session while believing they are still watching their run.

CONFIRMED (tui-builder), strongly. If reconnect is ever added it goes behind a
button, and the new daemon is treated as a NEW SESSION rather than a resumption
of the old one.

## The spawn race, and the connect-retry surface

Two clients starting at the same instant both find no socket and both spawn. The
loser's daemon exits on the lock; the loser's CLIENT retries the connect for a
bounded window and attaches to the winner. The race resolves itself and the user
sees a working session either way.

BUDGET: 2 seconds, confirmed by tui-builder. Its first paint is not a constraint
because the app mounts the home screen before awaiting the handshake, so the
user already sees something within a few hundred milliseconds.

THE RETRY IS A NAMED, CLIENT-VISIBLE SURFACE, not an internal detail. This is the
part that was nearly a repeat of the discarded-stderr bug: a 2 second silent wait
looks exactly like a hang, so the reason has to be reachable rather than merely
true.

The client-side contract, for tui-builder to implement over its own base and to
correct here if the wording is wrong:

```
connectState: 'connecting' | 'attached' | 'spawning' | 'waiting-for-engine' | 'failed'
```

- `connecting`   first connect attempt, no socket contacted yet
- `attached`     connected to a running daemon
- `spawning`     no daemon found, this client started one
- `waiting-for-engine`  entered when the retry has been running longer than
                 500ms, which is the point tui-builder renders a message rather
                 than an empty home
- `failed`       the budget expired; carries the reason, and the daemon's stderr
                 tail when one was spawned and exited

The 500ms threshold is the client's to tune; what this side owes is that the
states are distinguishable and that `failed` carries a reason a user can act on.

The engine side of this is small: the socket either exists or it does not, and
the lock refusal already names the holding pid. The work is making sure a client
can tell "no daemon yet" from "a daemon that refused to start", because those
call for different messages.

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
true.

CONFIRMED SAFE (tui-builder): nothing in the client treats `hello` as globally
first. `handshake()` runs once per client on mount and uses only the response,
to set the contract and engine versions and decide whether to show the upgrade
screen. No sequence numbers, no "did the daemon just start" inference, no state
assuming a fresh engine. FIRST-PER-CONNECTION is the wording to use.

## Work, in order

1. DONE (2026-08-16). Serialize state writes and fix the temp-name collision,
   with the N-concurrent test. It was landed independently of this proposal
   because it was a live defect rather than a future risk.
2. Socket server behind `--socket`, with the path-length check. THIS BUILD.
3. Per-connection pending maps and fan-out to all subscribers. THIS BUILD.
4. Client `SocketRpcClient` with attach-if-running. TUI-BUILDER'S, written over
   its existing `RpcClient` base so `on_event`, `on_board_finding` and the
   notification dispatch are shared and the two transports cannot drift.
5. Installer shim keeps targeting `daemon.js`; no change expected, confirmed
   with store-adapter.

Ends at the server plus this document. No client code from this side.

## What this does not solve

The stderr-discard problem for the window where a client still spawns its own
daemon: a startup failure that happens BEFORE the socket exists still has
nowhere to surface. tui-builder's stderr fix is what covers that, and it remains
necessary after this lands, because a daemon that cannot start cannot be
attached to either.
