/**
 * RESP (REdis Serialization Protocol), version 2 - the exact wire format real Redis uses.
 *
 * TCP gives us a STREAM of bytes, not separate messages. One `data` event may hold half a
 * command, or three commands at once. RESP solves that "framing" problem: every value starts
 * with a one-byte type marker and either ends with \r\n or announces its length up front.
 *
 *   +OK\r\n                      simple string  (short status replies)
 *   -ERR unknown command\r\n     error
 *   :42\r\n                      integer
 *   $5\r\nhello\r\n              bulk string    (length in BYTES, then the bytes)
 *   $-1\r\n                      null           ("no such key")
 *   *2\r\n$3\r\nGET\r\n$1\r\nk\r\n   array        (clients send every command as an array)
 *
 * Because we speak real RESP, a real Redis client could talk to our server (and our client
 * could talk to real Redis) - the learning transfers 1:1.
 */

export class SimpleString {
  constructor(readonly value: string) {}
}
export class RespError {
  constructor(readonly message: string) {}
}
export type Reply = string | number | null | SimpleString | RespError | Reply[];

export const OK = new SimpleString("OK");

/** Thrown when the bytes cannot be RESP at all. The server closes such a connection. */
export class ProtocolError extends Error {}

// Defensive limits: without them one client could make us allocate gigabytes.
const MAX_BULK_BYTES = 8 * 1024 * 1024;
const MAX_ARRAY_ITEMS = 1024 * 1024;
const MAX_INLINE_BYTES = 64 * 1024;

export function encode(v: Reply): string {
  if (v instanceof SimpleString) return `+${v.value}\r\n`;
  if (v instanceof RespError) return `-${v.message}\r\n`;
  if (typeof v === "number") return `:${v}\r\n`;
  if (v === null) return "$-1\r\n";
  // Byte length, NOT string length: "₹" is 1 JS character but 3 UTF-8 bytes.
  if (typeof v === "string") return `$${Buffer.byteLength(v)}\r\n${v}\r\n`;
  return `*${v.length}\r\n${v.map(encode).join("")}`;
}

/** A command as the client sends it: an array of bulk strings. */
export const encodeCommand = (args: (string | number)[]) => encode(args.map(String));

type Parsed = { value: Reply; end: number } | undefined; // undefined = "need more bytes"

function readLine(buf: Buffer, pos: number): { line: string; end: number } | undefined {
  const i = buf.indexOf("\r\n", pos);
  if (i === -1) {
    if (buf.length - pos > MAX_INLINE_BYTES) throw new ProtocolError("line too long");
    return undefined;
  }
  return { line: buf.toString("utf8", pos, i), end: i + 2 };
}

function readLength(line: string, max: number): number {
  const n = Number(line);
  if (!Number.isInteger(n) || n < -1 || n > max) throw new ProtocolError(`invalid length '${line}'`);
  return n;
}

function parseAt(buf: Buffer, pos: number): Parsed {
  const type = String.fromCharCode(buf[pos]);

  if (!"+-:$*".includes(type)) {
    // "Inline" command: plain text like `SET a 1` typed into telnet. Redis accepts it too.
    const l = readLine(buf, pos);
    if (!l) return undefined;
    return { value: l.line.trim().split(/\s+/).filter(Boolean), end: l.end };
  }

  const head = readLine(buf, pos + 1);
  if (!head) return undefined;

  switch (type) {
    case "+":
      return { value: new SimpleString(head.line), end: head.end };
    case "-":
      return { value: new RespError(head.line), end: head.end };
    case ":":
      return { value: Number(head.line), end: head.end };
    case "$": {
      const len = readLength(head.line, MAX_BULK_BYTES);
      if (len === -1) return { value: null, end: head.end };
      if (buf.length < head.end + len + 2) return undefined; // body not fully arrived yet
      return { value: buf.toString("utf8", head.end, head.end + len), end: head.end + len + 2 };
    }
    default: {
      const count = readLength(head.line, MAX_ARRAY_ITEMS);
      if (count === -1) return { value: null, end: head.end };
      const items: Reply[] = [];
      let end = head.end;
      for (let i = 0; i < count; i++) {
        if (end >= buf.length) return undefined;
        const item = parseAt(buf, end);
        if (!item) return undefined;
        items.push(item.value);
        end = item.end;
      }
      return { value: items, end };
    }
  }
}

/**
 * Incremental parser: feed it chunks as they arrive, pull out complete values.
 * (Simplification: an incomplete value is re-parsed from its start when more bytes arrive.
 * Fine for our sizes; real Redis keeps parse state to avoid that.)
 */
export class RespParser {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer | string) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.buf = this.buf.length ? Buffer.concat([this.buf, bytes]) : bytes;
  }

  next(): Reply | undefined {
    // Skip stray blank lines (e.g. an empty line typed in telnet).
    while (this.buf.length >= 2 && this.buf[0] === 13 && this.buf[1] === 10) this.buf = this.buf.subarray(2);
    if (this.buf.length === 0) return undefined;
    const parsed = parseAt(this.buf, 0);
    if (!parsed) return undefined;
    this.buf = this.buf.subarray(parsed.end);
    return parsed.value;
  }
}
