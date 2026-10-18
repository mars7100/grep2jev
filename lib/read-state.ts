/**
 * Level 8, shared: the file becomes Jev's state, never the agent's context.
 * Code reads it, refuses binaries and files over the budget, and hands back `{ path, content }`. Every ask_jev_file tool starts here.
 */
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { LIMITS } from "../core/types.ts";

/** Roughly four characters per token. The budget is shared with the questions, so leave room. */
export const MAX_FILE_CHARS = (LIMITS.TOTAL_TOKEN_BUDGET - 4000) * 4;

export interface FileState {
  path: string;
  content: string;
}

export class FileStateError extends Error {
  readonly path: string;
  constructor(message: string, path: string) {
    super(message);
    this.name = "FileStateError";
    this.path = path;
  }
}

const looksBinary = (buf: Buffer) => buf.subarray(0, 8192).includes(0);

/** File names that hold credentials. These never leave the machine, checked before the file is opened. */
export const SECRET_FILE =
  /^(\.env(\..*)?|.*\.env|.*\.(pem|key|p12|pfx|jks|keystore)|id_(rsa|dsa|ecdsa|ed25519)(\..*)?|\.(npmrc|pypirc|netrc|pgpass)|credentials(\..*)?|\.jev_key)$/i;

/**
 * Credentials hardcoded in ordinary files: private keys and well-known token formats.
 * ponytail: known formats only; `password = "hunter2"` still gets sent. Add an entropy check if that matters.
 */
export const SECRET_CONTENT = new RegExp([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----\s*[A-Za-z0-9+\/]{40}/, // PEM private keys, with key data: a bare header in a fixture is not a key
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})/, // GitHub
  /\bsk-[A-Za-z0-9_-]{20,}/, // OpenAI, Anthropic, OpenRouter
  /\b[rs]k_live_[A-Za-z0-9]{20,}/, // Stripe
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAIza[0-9A-Za-z_-]{35}/, // Google API key
].map((r) => r.source).join("|"));

/** Read one file as state. Errors name the path and the reason, so a tool can report them per file. */
export async function readFileState(path: string, cwd: string): Promise<FileState> {
  if (SECRET_FILE.test(basename(path))) throw new FileStateError(`secret file, not sent: ${path}`, path);
  const full = isAbsolute(path) ? path : resolve(cwd, path);
  let info;
  try {
    info = await stat(full);
  } catch {
    throw new FileStateError(`not found: ${path}`, path);
  }
  if (!info.isFile()) throw new FileStateError(`not a file: ${path}`, path);
  if (info.size > MAX_FILE_CHARS) {
    throw new FileStateError(`too large for one Jev call: ${path} is ${info.size} bytes, the limit is ${MAX_FILE_CHARS}`, path);
  }
  const buf = await readFile(full);
  if (looksBinary(buf)) throw new FileStateError(`binary: ${path}`, path);
  const content = buf.toString("utf8");
  if (SECRET_CONTENT.test(content)) throw new FileStateError(`possible credential in content, not sent: ${path}`, path);
  return { path, content };
}
