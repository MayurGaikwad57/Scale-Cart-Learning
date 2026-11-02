import fs from "node:fs";
import path from "node:path";

/**
 * One PARTITION = one append-only log file. This is the core idea of Kafka:
 *
 *   orders-0.log   {"offset":0,...}\n{"offset":1,...}\n{"offset":2,...}\n   <- only ever appended to
 *
 *  - A record's OFFSET is its position in the partition (0, 1, 2, ...). Offsets never change and
 *    are never reused, so a consumer can say "I have processed everything before offset 7".
 *  - Reading does NOT delete. Many consumer groups read the same log independently, each with
 *    its own position. (A queue like RabbitMQ deletes a message once it is consumed.)
 *  - Order is guaranteed only WITHIN a partition.
 *
 * Durability: every append is fsync'ed before we acknowledge it, so an acknowledged event
 * survives a crash or power loss ("acks=all" for a single broker). Real Kafka usually relies on
 * replication to other brokers instead of fsync per write - much faster, same guarantee.
 *
 * Simplifications vs Kafka (fine for learning, called out on purpose):
 *  - one file per partition, no segment files, no retention/deletion, no index files;
 *  - all records are also kept in memory for fast reads.
 */

export interface LogRecord {
  offset: number;
  timestamp: number;
  key: string;
  value: string;
  headers: Record<string, string>;
}

export class PartitionLog {
  private readonly records: LogRecord[] = [];
  private readonly fd: number;

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.load();
    this.fd = fs.openSync(file, "a");
  }

  /** Next offset to be written = number of records ("log end offset" / high watermark). */
  get endOffset() {
    return this.records.length;
  }

  /**
   * Rebuild the in-memory view from the file. If the process crashed in the middle of a write,
   * the LAST line can be half-written ("torn write"). Such a record was never acknowledged to a
   * producer, so it is safe to cut it off - that's exactly what Kafka's recovery does too.
   */
  private load() {
    if (!fs.existsSync(this.file)) return;
    const text = fs.readFileSync(this.file, "utf8");
    let validBytes = 0;
    for (const line of text.split("\n")) {
      if (line === "") continue;
      let rec: LogRecord;
      try {
        rec = JSON.parse(line) as LogRecord;
      } catch {
        break; // torn last record
      }
      if (rec.offset !== this.records.length) break; // corrupted / out of order: stop here
      this.records.push(rec);
      validBytes += Buffer.byteLength(line) + 1;
    }
    if (validBytes < Buffer.byteLength(text)) {
      console.warn(`[scalelog] ${path.basename(this.file)}: dropped ${Buffer.byteLength(text) - validBytes} bytes of a torn write`);
      fs.truncateSync(this.file, validBytes);
    }
  }

  append(input: Omit<LogRecord, "offset" | "timestamp">): LogRecord {
    const rec: LogRecord = { offset: this.records.length, timestamp: Date.now(), ...input };
    fs.writeSync(this.fd, JSON.stringify(rec) + "\n");
    fs.fsyncSync(this.fd); // durable BEFORE we say "ok" to the producer
    this.records.push(rec);
    return rec;
  }

  read(fromOffset: number, max: number): LogRecord[] {
    return this.records.slice(fromOffset, fromOffset + max);
  }

  close() {
    fs.closeSync(this.fd);
  }
}
