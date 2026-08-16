# Install

Daijin is two halves that ship together: a Node engine and a Textual client. This
directory installs both into one prefix and puts exactly one command on your PATH.

**Nothing here is published.** Distribution of Daijin is the owner's act, so no download
URL is baked into the installer. It installs from a checkout until the owner decides
otherwise. A curl form pointing at an unpublished URL would be a script that has never run
its own happy path, so it does not exist yet.

## Install

```
git clone <the repository>
bash daijin/install/install.sh
```

Options, all environment variables:

| variable | default | what it does |
| --- | --- | --- |
| `DAIJIN_PREFIX` | `~/.local/share/daijin` | where the program goes |
| `DAIJIN_BIN_DIR` | `~/.local/bin` | where the single `daijin` command is linked |
| `DAIJIN_SOURCE` | the checkout the script came from | install from a specific checkout |
| `DAIJIN_REPO_URL` | none | clone and install from a repository instead |
| `DAIJIN_OLLAMA_URL` | `$OLLAMA_BASE_URL` or `http://localhost:11434` | where the completion probe looks for the embedder |
| `DAIJIN_EMBED_MODEL` | `bge-m3` | the embedding model the probe expects |

Requirements, checked before anything is written: Node 22 or newer (better-sqlite3 needs
it), Python 3.10 or newer with `venv`, and git. Each failure names the tool it looked at
and what to do about it.

**Retrieval also needs a local [Ollama](https://ollama.com/download) serving `bge-m3`.**
That is a RUNTIME requirement, not an install requirement, and the difference is
deliberate: the install completes and is correct on a machine whose embedder arrives
later, so the installer never fails on it. What it does instead is probe at the end and
tell you which of the two situations you are in, because an installer that prints
"installed" while retrieval cannot work is the more expensive kind of wrong.

```
ollama pull bge-m3     # 1024 dimensions, the measured default
```

If Ollama is somewhere other than `http://localhost:11434`, point the probe at it with
`DAIJIN_OLLAMA_URL`, and the model name is `DAIJIN_EMBED_MODEL`.

## What it puts where

```
$PREFIX/engine      the Node engine and its production dependencies
$PREFIX/adapters    a sibling of engine, because engine imports ../../../adapters
$PREFIX/tui         the client source
$PREFIX/venv        a PRIVATE virtualenv holding the client
$PREFIX/bin/daijin  the shim, the only thing that reaches your PATH
$PREFIX/VERSION     the stamp: both versions, the source commit, the runtimes
$PREFIX/install.log every step of the last run
```

Two layout decisions worth knowing:

**The prefix is not `~/.daijin`.** That path belongs to the engine daemon, which keeps
per-user state there: which repositories are attached, what your settings are. The program
and the state have different lifetimes, so they get different directories. An uninstall can
then remove the program without touching anything you would miss.

**The client lives in a private virtualenv.** pip's own console script would sit inside
that venv where PATH cannot reach it, and installing the client globally would argue with
whatever else your Python has. One shim on PATH solves both without touching your system.

## What the shim does

It decides the engine command at run time, not at install time, so an engine that gains
capabilities after you installed starts being used without a reinstall. It adds
`--engine 'node $PREFIX/engine/src/rpc/daemon.js'` only when you did not choose one
yourself, and `--mock` always wins, because the client's own bundled engine is a
deliberate choice.

`daemon.js` is the process entry point. `server.js` beside it exports the dispatcher and
does nothing when run directly, so a launcher pointed at the library produces a process
that exits without answering.

If the engine is missing from a prefix, the shim refuses and says so. There is no stand-in
daemon to fall back to: a stub that answers `hello` makes a broken install look finished,
which is the one thing the smoke check exists to prevent, and it would carry a hardcoded
contract version that drifts the moment `methods.md` moves. One did, within a day, from 4
to 5.

## Verify an install

```
node $PREFIX/install/smoke.mjs --prefix $PREFIX
```

It speaks the real wire format to the real daemon and compares hello's `engineVersion`
against `$PREFIX/VERSION`. Comparing against the stamp rather than against a constant is
what makes it a check: it catches a stale install, a half copied tree, and a daemon
reporting a version it did not come from. The installer runs it as its last step and
refuses to call an install finished if it fails.

The check runs the daemon with `--no-probe` and its own `--state-root` inside the prefix,
so verifying an install contacts no service and writes nothing you would notice.

## The clean-machine dry run

```
bash install/dry-run.sh              # everything, into a throwaway prefix
DAIJIN_KEEP=1 bash install/dry-run.sh  # keep the work directory to look at
```

It installs into a temp prefix with a temp bin dir, asserts every acceptance criterion,
and removes both afterwards. It never touches your real install, your PATH, or any
repository. Criteria, in the order it checks them:

- **(a) a clean install produces a working command.** Layout, then `daijin --help` all the
  way through shim, venv, Python and argparse, then a hello handshake against the daemon.
- **(b) idempotent.** Runs the installer twice and asserts the shim is byte identical, no
  second command appeared, and nothing nested itself.
- **(c) no secret, no provider call, no network beyond package registries.** Sweeps the
  shipped files for provider hostnames, credential names and auth headers, asserts the
  installer runs no downloader of its own, and asserts the installed tree carries no
  credential file of ours.
- **(d) both halves stamped, hello sourced from the stamp.**
- **(e) uninstall.** Removes the program, leaves a repository brain alone, and is not an
  error the second time.
- **(f) dash sweep.**
- **(g) the embedder is probed at completion and never blocks the install.** Both branches
  are exercised against a mock endpoint and a closed port, never a live service, and each
  asserts its own message: the ready branch says retrieval is ready, the missing branch
  names the next command and the completion line stops claiming a working install.
- **(h) the preflight refusals actually refuse.** Node hidden from PATH, a node reporting
  v20, and a Python without `venv`, each asserting the installer stops with its named
  message. A requirement nobody has ever seen fail is a requirement nobody has checked.

Two criteria are checked by **mutation** rather than observation, because a check that
cannot fail is not a check:

- the stamp is corrupted on purpose and the smoke check must refuse, then pass again once
  it is restored;
- the shim's argument contract is observed through a stand-in that records its argv, so
  "adds an engine", "leaves `--mock` alone" and "does not double an explicit `--engine`"
  are each proven rather than read;
- the engine is moved aside and the smoke check and the shim must both refuse, so "an
  install without an engine looks broken" is demonstrated rather than assumed;
- the dash sweep itself is proven alive on every run against a planted em dash, because
  the first version of it was written with `grep` and passed with one. `grep` flavours
  differ in `-P` support and in how they read alternation, so the sweep is python now.

## Uninstall

```
bash $PREFIX/install/uninstall.sh          # prompts
DAIJIN_YES=1 bash $PREFIX/install/uninstall.sh
```

It removes the prefix and the PATH symlink, and the symlink only when it points into that
prefix. It leaves `~/.daijin` (the engine's state: attached repositories and settings) and
every repository brain in place, and prints where they are. Deleting someone's data is not
an uninstaller's business.

## What this does not do yet

- **Publish.** No hosting, no signing, no checksum of a released artifact. When the owner
  publishes, the curl one-liner in `install.sh`'s header becomes real and the script grows
  a checksum step; today it would be a step that verifies nothing.
- **Windows.** The shim is a POSIX shell script. macOS and Linux only.
- **Offline install.** npm and pip reach their registries. A vendored offline mode is
  possible and is not built.
