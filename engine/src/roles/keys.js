// Resolving a role's key from a POINTER, never from a stored value.
//
// The standing rule this implements: no key value enters this repository, its settings
// files, its logs, or any RPC response. A role carries `keyRef`, a name; the value is
// fetched at the moment a provider call is made and is never returned to a caller that is
// not making one.
//
// The pointer forms are the platform's own conventions rather than new ones, because the
// first repo to be wired here IS the platform and its key already lives behind a pointer:
// `.env.local` holds `OPENROUTER_API_KEY_FILE`, which names a file outside the repository,
// which holds the key. Two hops, both by name. A design that flattened that into "paste the
// key into daijin's settings" would take a secret that is currently in one 0600 file and
// copy it into a JSON file in a state directory.
//
//   env:NAME                    process.env[NAME] is the key
//   file:/abs/path              the file's contents are the key
//   env-file:/abs/path#NAME     NAME read from a dotenv-style file; if NAME ends in _FILE
//                               the value is a path and the key is that file's contents
//
// The contract also documents a BARE pointer, "the name of an environment variable or a
// file path". That single sentence describes two meanings for one string, which is a real
// ambiguity rather than a convenience: a keyRef of /home/me/key means a file to a reader
// and an environment lookup to the old code. It is resolved by SHAPE rather than broken:
// an absolute path is a file, a SHOUTING_NAME is an environment variable, and anything
// else is refused instead of guessed. The prefixed forms above are unambiguous and are
// what a new configuration should use.
//
// The _FILE suffix rule is the platform's convention (OPENROUTER_API_KEY_FILE,
// ZAI_API_KEY_FILE, PROVIDER_ROUTER_SHARED_SECRET_FILE), followed here rather than
// reinvented so a pointer copied from one place means the same thing in the other.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const KEY_REF_FORMS = Object.freeze(['env:NAME', 'file:/abs/path', 'env-file:/abs/path#NAME']);

/**
 * Parse a pointer without resolving it.
 *
 * Separate from resolution on purpose: a settings screen has to be able to say "this
 * pointer is malformed" without reading a secret to find out, and a test has to be able to
 * check the shape without a key existing.
 */
export function parseKeyRef(keyRef) {
  const text = String(keyRef ?? '').trim();
  if (!text) return null;
  if (text.startsWith('env-file:')) {
    const body = text.slice('env-file:'.length);
    const hash = body.lastIndexOf('#');
    if (hash <= 0 || hash === body.length - 1) return null;
    return { kind: 'env-file', file: body.slice(0, hash), name: body.slice(hash + 1) };
  }
  if (text.startsWith('file:')) {
    const file = text.slice('file:'.length);
    return file ? { kind: 'file', file } : null;
  }
  if (text.startsWith('env:')) {
    const name = text.slice('env:'.length);
    return name ? { kind: 'env', name } : null;
  }
  // The legacy bare form, disambiguated by shape.
  if (path.isAbsolute(text)) return { kind: 'file', file: text, legacy: true };
  if (/^[A-Z][A-Z0-9_]*$/.test(text)) return { kind: 'env', name: text, legacy: true };
  // Anything else is REFUSED rather than guessed. A lowercase relative string is the shape
  // of a mistake, and guessing which of two meanings a user intended is how a key ends up
  // somewhere nobody expected.
  return null;
}

/// One variable out of a dotenv-style file. Deliberately minimal: it reads exactly the name
/// asked for and never returns the file's other contents to the caller.
function readDotenvValue(text, name) {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    if (line.slice(0, equals).trim() !== name) continue;
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return null;
}

/**
 * The key behind a pointer, or a refusal that names what is missing WITHOUT quoting it.
 *
 * Errors here are read by users and pasted into issues, so they name the pointer and the
 * hop that failed and never the value. "OPENROUTER_API_KEY_FILE is set but the file it
 * names cannot be read" is actionable; printing the path's contents would be a leak in a
 * bug report.
 */
export async function resolveKey(keyRef, { environment = process.env, read = readFile } = {}) {
  const parsed = parseKeyRef(keyRef);
  if (!parsed) {
    throw new Error(`Unusable key pointer ${JSON.stringify(String(keyRef ?? ''))}. Expected one of: ${KEY_REF_FORMS.join(', ')}.`);
  }
  if (parsed.kind === 'env') {
    const value = environment[parsed.name];
    if (!value) throw new Error(`The environment variable ${parsed.name} is not set, so this role has no key.`);
    return value.trim();
  }
  if (parsed.kind === 'file') {
    return readSecretFile(parsed.file, read, `The key file ${parsed.file}`);
  }

  let contents;
  try {
    contents = await read(parsed.file, 'utf8');
  } catch {
    throw new Error(`Cannot read the environment file ${parsed.file}, so ${parsed.name} cannot be resolved.`);
  }
  const value = readDotenvValue(contents, parsed.name);
  if (!value) throw new Error(`${parsed.name} is not set in ${parsed.file}, so this role has no key.`);
  // The platform's convention: a name ending in _FILE holds a PATH, not a secret.
  if (parsed.name.endsWith('_FILE')) {
    return readSecretFile(value, read, `${parsed.name} in ${parsed.file} names ${value}, which`);
  }
  return value;
}

async function readSecretFile(file, read, subject) {
  let contents;
  try {
    contents = await read(file, 'utf8');
  } catch {
    throw new Error(`${subject} cannot be read, so this role has no key.`);
  }
  const value = contents.trim();
  if (!value) throw new Error(`${subject} is empty, so this role has no key.`);
  return value;
}

/**
 * Is this pointer resolvable right now, without telling the caller what is behind it?
 *
 * This is what a settings screen calls. It returns a boolean and a reason, never the key,
 * so "the watcher is ready" can be shown without a secret crossing the RPC boundary. The
 * reason is the resolver's own message, which names the hop that failed.
 */
export async function checkKeyRef(keyRef, options = {}) {
  try {
    await resolveKey(keyRef, options);
    return { resolvable: true, reason: null };
  } catch (error) {
    return { resolvable: false, reason: error.message };
  }
}
