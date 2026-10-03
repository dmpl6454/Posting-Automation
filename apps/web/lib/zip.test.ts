import { describe, it, expect } from "vitest";
import { buildZip, crc32 } from "./zip";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A tiny independent reader: walks the central directory and returns entries. */
function readZip(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdAt = bytes.length - 22;
  expect(dv.getUint32(eocdAt, true)).toBe(0x06054b50);
  const count = dv.getUint16(eocdAt + 10, true);
  const cdSize = dv.getUint32(eocdAt + 12, true);
  const cdOffset = dv.getUint32(eocdAt + 16, true);
  expect(cdOffset + cdSize).toBe(eocdAt);
  const entries: { name: string; data: string; crc: number }[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    expect(dv.getUint32(p, true)).toBe(0x02014b50);
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    expect(dv.getUint32(localOff, true)).toBe(0x04034b50);
    const lNameLen = dv.getUint16(localOff + 26, true);
    const dataStart = localOff + 30 + lNameLen;
    const data = bytes.subarray(dataStart, dataStart + size);
    expect(crc32(data)).toBe(crc);
    entries.push({ name, data: dec.decode(data), crc });
    p += 46 + nameLen;
  }
  return entries;
}

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("buildZip", () => {
  it("writes a well-formed store archive the central directory can walk back", () => {
    const zip = buildZip([
      { name: "index.csv", data: "a,b\n1,2" },
      { name: "campaigns/diwali-2026.csv", data: "x" },
      { name: "posts/post-abcd1234-héllo.csv", data: enc.encode("ünïcödé") },
    ]);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(["index.csv", "campaigns/diwali-2026.csv", "posts/post-abcd1234-héllo.csv"]);
    expect(entries[0]!.data).toBe("a,b\n1,2");
    expect(entries[2]!.data).toBe("ünïcödé");
  });

  it("an empty archive is just the end record", () => {
    const zip = buildZip([]);
    expect(zip.length).toBe(22);
    expect(readZip(zip)).toEqual([]);
  });

  it("stores entries uncompressed with the UTF-8 flag", () => {
    const zip = buildZip([{ name: "f.csv", data: "hello" }]);
    const dv = new DataView(zip.buffer);
    expect(dv.getUint16(6, true)).toBe(0x0800); // flags
    expect(dv.getUint16(8, true)).toBe(0); // method: store
    expect(dv.getUint32(18, true)).toBe(5); // compressed size == raw size
  });
});
