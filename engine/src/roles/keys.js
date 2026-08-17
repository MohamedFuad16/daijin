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

/// What an environment variable may be named. Hyphens, dots and spaces cannot appear in
/// one, which is what makes this a usable filter against a pasted key.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * WHY a pointer was refused, in a sentence that names the fix.
 *
 * parseKeyRef answers yes or no, which is all a caller needs to decide and nothing a user
 * needs to act on. House rule: a refusal carries its action. A relative pointer rejected
 * with a bare list of accepted forms leaves the reader diffing their own string against
 * three examples to find the one character that is wrong.
 *
 * THE INPUT IS NEVER ECHOED. My first version quoted it, which reads as helpful and is a
 * SECRET LEAK: the likeliest wrong value here is a pasted API key, and this string crosses
 * the RPC boundary and lands in logs. The module exists to keep key values out of exactly
 * those places, and a diagnostic that quotes what it refuses defeats the refusal. Every
 * message below describes the SHAPE that was wrong and the shape that is wanted.
 *
 * It also does not suggest a resolved absolute path. path.resolve here would resolve
 * against the DAEMON's working directory, inside a sentence explaining that the daemon's
 * working directory cannot be relied on, and would hand the user a confidently wrong path
 * under the engine's install location.
 *
 * Returns null when the pointer is fine, so it reads as "no complaint".
 */
export function keyRefRefusal(keyRef) {
  const text = String(keyRef ?? '').trim();
  if (!text) return 'The pointer is empty.';
  if (parseKeyRef(text)) return null;

  for (const prefix of ['env-file:', 'file:']) {
    if (!text.startsWith(prefix)) continue;
    const body = text.slice(prefix.length);
    if (prefix === 'env-file:') {
      const hash = body.lastIndexOf('#');
      if (hash <= 0 || hash === body.length - 1) {
        return 'An env-file pointer needs a variable name after a #, as env-file:/absolute/path#VARIABLE_NAME.';
      }
      if (!path.isAbsolute(body.slice(0, hash))) {
        return 'The path in an env-file pointer is relative. It is read by the daemon, which does not share your shell\'s working directory, so give the full path from the root: env-file:/absolute/path#VARIABLE_NAME.';
      }
      return null;
    }
    if (!path.isAbsolute(body)) {
      return 'The path is relative. It is read by the daemon, which does not share your shell\'s working directory, so give the full path from the root, as file:/absolute/path.';
    }
  }
  if (text.startsWith('env:')) {
    return 'An env pointer needs the NAME of an environment variable after the colon, as env:VARIABLE_NAME. A name may hold letters, digits and underscores, so anything with dashes or dots is not one, and a key value is never accepted here.';
  }
  // The bare form. This is where a PASTED KEY lands, so the message says what a pointer is
  // rather than trying to classify what was given, and names nothing back.
  return `A pointer is the NAME of a place a key is kept, never the key. Use an environment variable name in capitals, an absolute file path, or one of the explicit forms: ${KEY_REF_FORMS.join(', ')}.`;
}


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
    const file = body.slice(0, hash);
    if (!path.isAbsolute(file)) return null;
    return { kind: 'env-file', file, name: body.slice(hash + 1) };
  }
  if (text.startsWith('file:')) {
    const file = text.slice('file:'.length);
    // ABSOLUTE ONLY, which the contract already said and this parser did not enforce.
    // Found by tui-builder's conformance test running 28 inputs through this function and
    // comparing verdicts: their mirror refused `file:rel` and was CLOSER TO THE CONTRACT
    // THAN THE ENGINE, which no amount of re-reading either side would have shown, because
    // each matched what its author believed.
    //
    // It matters beyond tidiness: a relative pointer resolves against the DAEMON's working
    // directory, which is whatever directory it was launched from and is not the user's.
    // So the same setting reads a different file depending on how the daemon was started,
    // or none at all. That is not a pointer, it is a coin flip.
    //
    // The bare form already refused relative strings for a neighbouring reason. The prefix
    // removes the ambiguity about env-versus-file; it does not remove the ambiguity about
    // WHICH FILE, and the guard was written at one site and not its sibling.
    if (!file || !path.isAbsolute(file)) return null;
    return { kind: 'file', file };
  }
  if (text.startsWith('env:')) {
    const name = text.slice('env:'.length);
    // THE NAME IS SHAPE CHECKED TOO, and it was not. The prefix resolves env-versus-file
    // and says nothing about whether what follows can be an environment variable at all,
    // so `env:` plus a PASTED KEY was accepted, stored, and failed much later as an unset
    // variable, with the user reading it as the provider being down.
    //
    // Same defect as the relative-path one two branches up, found by the test written for
    // that one: a prefix removes one ambiguity and the guard for the remaining one was
    // never written. Case is allowed here, unlike the bare form which must SHOUT to be
    // told apart from a path, because a lowercase environment variable is legal and the
    // prefix has already done the disambiguating.
    return ENV_NAME.test(name) ? { kind: 'env', name } : null;
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
