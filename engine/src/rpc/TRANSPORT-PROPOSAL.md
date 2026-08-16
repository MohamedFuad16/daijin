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
connectState: 'connecting' | 'spawning' | 'attached' | 'failed'
elapsedMs:    milliseconds since the connect attempt began
failed:       { reason: string, engineStderr: string | null }
```

- `connecting`  trying to reach an existing daemon, none contacted yet
- `spawning`    no daemon found, this client started one and is waiting for it
- `attached`    connected
- `failed`      the budget expired

REVISED after tui-builder's review (approved 2026-08-16). The first draft had a
`waiting-for-engine` state "entered after 500ms", and also said the threshold was
the client's to tune. Those cannot both hold: if this side performs the
transition then the number is ours, and a client that chose 300ms would render
its message 200ms late with neither side wrong in its own file. So the STATE is
gone and `elapsedMs` replaces it. Waiting is a rendering decision the client
makes at its own threshold, and this side carries no number belonging to someone
else's UI.

`connecting` and `spawning` both stay, and the reason is not cosmetic: they are
different sentences ("Connecting to the engine" against "Starting the engine")
and they imply different next actions when they never resolve. One means look at
why the daemon died; the other means look at whether someone else's daemon is
wedged. The flat enum with `waiting-for-engine` in it destroyed exactly that
distinction at the moment it mattered most, because a client that spawned and has
waited 800ms would have had to be in one state and would have lost the ownership
fact.

`failed.engineStderr` is a plain newline-joined string bounded to the last 20
lines, matching what the client captures, and it is NULLABLE with a meaning:

  NULL MEANS THIS CLIENT ATTACHED RATHER THAN SPAWNED, so it never had that
  daemon's stderr. It does NOT mean the engine said nothing.

Rendering null as an empty "the engine said" block would tell a user the daemon
was silent when it may have written a perfectly good refusal to a terminal two
windows away. That is the discarded-stderr bug again, one level up, so the shape
has to let the two cases be told apart; nullability does and an empty string does
not.

What this side owes: distinguishable states, an honest `elapsedMs`, and a
`failed` a user can act on.

The engine side of this is small: the socket either exists or it does not, and
the lock refusal already names the holding pid. The work is making sure a client
can tell "no daemon yet" from "a daemon that refused to start", because those
call for different messages.

## Client-side concurrency: no cap, and the measurement behind that

tui-builder asked whether it should cap concurrent calls, noting its repo home
issues 10 calls on load and its polish pass will make nine of them concurrent, so
three attached TUIs refreshing at once is 27 in flight. It asked for the number
from the side that knows the daemon's appetite rather than picking one.

MEASURED, not estimated, against the real socket daemon on this machine:

```
one client,  9 sequential : 23ms   (2.6ms per call)
one client,  9 concurrent : 13ms
3 clients x 9 concurrent  : 37ms   (27 calls, 1.4ms per call)
one analyze               : 41ms
3 concurrent analyze      : 40ms   (1.0x the cost of one)
```

ANSWER: no cap. Ship the concurrency uncapped behind a constant that is trivial
to change later. 27 cheap reads in flight cost 37ms in total, and three
concurrent `analyze` calls cost the same wall clock as one, because they are
filesystem bound and overlap.

Two facts worth having rather than the number alone:

- A burst on ONE connection is chained inside the daemon: handlers for a single
  connection run one at a time, deliberately, so a slow handler cannot interleave
  a half-written line into that client's stream. The burst is still faster than
  the sequential version (13ms against 23ms) because the round trips overlap.
  Connections do not block each other.
- The risk is WHICH methods, not how many. Everything measured above is cheap or
  filesystem bound. The methods that would actually contend are the ones that
  embed (`search`, `retrievalScore`, `diagnose`), because they queue behind one
  local Ollama, and those are worth serialising in the CLIENT if a screen ever
  fires several at once. The long ones (`initBrain`, `gatesDiscover`) are already
  jobs and return immediately, so they cannot pile up.

BASIS: measured 2026-08-16 on this machine, cheap reads and one filesystem-bound
method, single daemon, three clients. NOT measured: concurrent embedding calls,
and a corpus larger than the fixtures. If a screen starts issuing concurrent
`search`, that is the case to measure before trusting this.

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
