/**
 * Minimal STORE-only ZIP writer for the Reports "Download per campaign" bundle
 * (2026-10-03). ~60 lines instead of a dependency: the archive holds a handful
 * of small CSVs, so compression buys nothing, and a hand-rolled writer has no
 * supply-chain surface. Pure + tested (zip.test.ts, which also round-trips the
 * output through a real unzipper in CI).
 *
 * Format: one local file header + data per entry, a central directory, and the
 * end-of-central-directory record. Names are UTF-8 (general-purpose bit 11).
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** Forward-slash path inside the archive, e.g. "campaigns/diwali-2026.csv". */
  name: string;
  data: Uint8Array | string;
}

/** MS-DOS date/time fields (local time, 2-second resolution), as ZIP requires. */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export function buildZip(entries: ZipEntry[], now: Date = new Date()): Uint8Array {
  const enc = new TextEncoder();
  return assemble(
    entries.map((e) => {
      const data = typeof e.data === "string" ? enc.encode(e.data) : e.data;
      return { name: e.name, raw: data, stored: data, method: 0 };
    }),
    now
  );
}

/**
 * DEFLATE-compressed variant (2026-11-23) for the Excel export, whose XML for
 * a large workspace runs to tens of MB but compresses ~10x. Uses the browser's
 * native `CompressionStream("deflate-raw")` (no dependency); where that is
 * missing, or an entry doesn't shrink, the entry is STORED — still a valid ZIP.
 * `buildZip` above is untouched, so the per-campaign bundle is byte-identical.
 */
export async function buildZipCompressed(entries: ZipEntry[], now: Date = new Date()): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const parts: Part[] = [];
  for (const e of entries) {
    const raw = typeof e.data === "string" ? enc.encode(e.data) : e.data;
    const deflated = await deflateRaw(raw);
    parts.push(
      deflated && deflated.length < raw.length
        ? { name: e.name, raw, stored: deflated, method: 8 }
        : { name: e.name, raw, stored: raw, method: 0 }
    );
  }
  return assemble(parts, now);
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw" as CompressionFormat));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** One archive entry: `raw` is the original bytes (CRC + uncompressed size), `stored` what is written. */
interface Part {
  name: string;
  raw: Uint8Array;
  stored: Uint8Array;
  method: 0 | 8;
}

function assemble(parts: Part[], now: Date): Uint8Array {
  const enc = new TextEncoder();
  const entries = parts;
  const { time, date } = dosDateTime(now);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = e.stored;
    const crc = crc32(e.raw);

    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // flags: UTF-8 names
    lv.setUint16(8, e.method, true); // method: 0 store, 8 deflate
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed size
    lv.setUint32(22, e.raw.length, true); // uncompressed size
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(name, 30);
    local.set(data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, e.method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, e.raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk start
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // local header offset
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

/** Trigger a browser download of a ZIP byte array. */
export function downloadZip(filename: string, bytes: Uint8Array) {
  const blob = new Blob([bytes as BlobPart], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
