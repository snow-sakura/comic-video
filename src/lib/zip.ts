/**
 * 极简 ZIP 写入器（STORE 模式，无压缩、无依赖）
 * - 适用于本工具小体积产物（图片/短视频/音频），体积小、可缓存复用
 * - 文件名 UTF-8（置 bit 11），兼容 macOS/Windows 解压
 */
import { crc32 } from "node:zlib";

export interface ZipEntry {
  name: string; // 目录内路径，如 "ep1/01-场景/image.png"
  data: Buffer;
}

function localHeader(nameBuf: Buffer, crc: number, size: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.writeUInt32LE(0x04034b50, 0); // signature
  buf.writeUInt16LE(20, 4); // version needed
  buf.writeUInt16LE(0x0800, 6); // flags: UTF-8
  buf.writeUInt16LE(0, 8); // method: store
  buf.writeUInt16LE(0, 10); // mod time
  buf.writeUInt16LE(0x21, 12); // mod date
  buf.writeUInt32LE(crc >>> 0, 14);
  buf.writeUInt32LE(size, 18);
  buf.writeUInt32LE(size, 22);
  buf.writeUInt16LE(nameBuf.length, 26);
  buf.writeUInt16LE(0, 28); // extra len
  return Buffer.concat([buf, nameBuf]);
}

function centralHeader(nameBuf: Buffer, crc: number, size: number, offset: number): Buffer {
  const buf = Buffer.alloc(46);
  buf.writeUInt32LE(0x02014b50, 0); // signature
  buf.writeUInt16LE(20, 4); // version made by
  buf.writeUInt16LE(20, 6); // version needed
  buf.writeUInt16LE(0x0800, 8); // flags
  buf.writeUInt16LE(0, 10); // method
  buf.writeUInt16LE(0, 12); // mod time
  buf.writeUInt16LE(0x21, 14); // mod date
  buf.writeUInt32LE(crc >>> 0, 16);
  buf.writeUInt32LE(size, 20);
  buf.writeUInt32LE(size, 24);
  buf.writeUInt16LE(nameBuf.length, 28);
  buf.writeUInt16LE(0, 30); // extra
  buf.writeUInt16LE(0, 32); // comment
  buf.writeUInt16LE(0, 34); // disk
  buf.writeUInt16LE(0, 36); // internal attrs
  buf.writeUInt32LE(0, 38); // external attrs
  buf.writeUInt32LE(offset, 42);
  return Buffer.concat([buf, nameBuf]);
}

/** 生成 ZIP（STORE） */
export function buildZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const local = localHeader(nameBuf, crc, e.data.length);
    parts.push(local, e.data);
    central.push(centralHeader(nameBuf, crc, e.data.length, offset));
    offset += local.length + e.data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // central disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...parts, centralBuf, eocd]);
}
