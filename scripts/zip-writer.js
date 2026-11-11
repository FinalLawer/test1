'use strict';

/**
 * 极简 ZIP 写入器（无第三方依赖）。
 *
 * 为什么不用 PowerShell Compress-Archive / 系统 7z：
 *  - 前者对中文文件名不写 UTF-8 标志位，资源管理器解压会乱码；
 *  - 后者不是每台机器都装了，也不在 PATH 里。
 * 这里用 data descriptor（flag bit 3）流式压缩，避免把 200MB 的 exe 整个读进内存；
 * 同时置 UTF-8 标志位（bit 11），中文 exe 名 / README 名都能正确还原。
 *
 * 只支持 ZIP32（单文件 < 4GB、条目 < 65535），Electron 发行目录远小于此。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Transform, Writable } = require('stream');
const { pipeline } = require('stream/promises');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf, seed = 0) {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const y = Math.max(1980, Math.min(2107, date.getFullYear()));
  return {
    date: ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  };
}

/** 递归收集条目，名称统一用 / 分隔并相对 root，排序保证产物可复现 */
function collect(root, rel = '', out = []) {
  const here = rel ? path.join(root, rel) : root;
  for (const ent of fs.readdirSync(here, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    const full = path.join(root, childRel);
    if (ent.isDirectory()) {
      out.push({ name: childRel + '/', full, isDir: true, stat: fs.statSync(full) });
      collect(root, childRel, out);
    } else if (ent.isFile()) {
      out.push({ name: childRel, full, isDir: false, stat: fs.statSync(full) });
    }
  }
  return out;
}

function writeAll(fd, buf) {
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
}

/** @returns {Promise<{entries:number, files:number, dirs:number, bytes:number, path:string}>} */
async function createZip(rootDir, outFile, { level = 6, onProgress, prefix = '' } = {}) {
  const entries = collect(rootDir);
  // prefix 让解压后是一个整齐的文件夹，而不是散在解压目录里的一堆文件
  if (prefix) {
    const head = prefix.replace(/\/+$/, '') + '/';
    entries.unshift({ name: head, full: rootDir, isDir: true, stat: fs.statSync(rootDir) });
    for (let i = 1; i < entries.length; i++) entries[i].name = head + entries[i].name;
  }
  const fd = fs.openSync(outFile, 'w');
  let offset = 0;
  const put = (buf) => {
    writeAll(fd, buf);
    offset += buf.length;
  };
  const central = [];

  try {
    for (const ent of entries) {
      const nameBuf = Buffer.from(ent.name, 'utf8');
      const { date, time } = dosDateTime(ent.stat.mtime);
      const flag = 0x0800 | (ent.isDir ? 0 : 0x0008); // UTF-8 + 文件用 data descriptor
      const method = ent.isDir ? 0 : 8;                // store / deflate
      const localOffset = offset;

      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);       // version needed 2.0
      lh.writeUInt16LE(flag, 6);
      lh.writeUInt16LE(method, 8);
      lh.writeUInt16LE(time, 10);
      lh.writeUInt16LE(date, 12);
      lh.writeUInt16LE(nameBuf.length, 26);
      put(lh);
      put(nameBuf);

      let crc = 0;
      let size = 0;
      let csize = 0;

      if (!ent.isDir) {
        const crcStream = new Transform({
          transform(chunk, _enc, cb) {
            crc = crc32(chunk, crc);
            size += chunk.length;
            cb(null, chunk);
          }
        });
        const sink = new Writable({
          write(chunk, _enc, cb) {
            csize += chunk.length;
            try {
              put(chunk);
              cb();
            } catch (err) {
              cb(err);
            }
          }
        });
        await pipeline(
          fs.createReadStream(ent.full),
          crcStream,
          zlib.createDeflateRaw({ level }),
          sink
        );

        const dd = Buffer.alloc(16);
        dd.writeUInt32LE(0x08074b50, 0);
        dd.writeUInt32LE(crc, 4);
        dd.writeUInt32LE(csize, 8);
        dd.writeUInt32LE(size, 12);
        put(dd);
      }

      central.push({ nameBuf, flag, method, time, date, crc, csize, size, localOffset, isDir: ent.isDir });
      if (onProgress) onProgress(ent.name, size);
    }

    const cdOffset = offset;
    for (const e of central) {
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);       // version made by: MS-DOS / 2.0
      ch.writeUInt16LE(20, 6);       // version needed
      ch.writeUInt16LE(e.flag, 8);
      ch.writeUInt16LE(e.method, 10);
      ch.writeUInt16LE(e.time, 12);
      ch.writeUInt16LE(e.date, 14);
      ch.writeUInt32LE(e.crc, 16);
      ch.writeUInt32LE(e.csize, 20);
      ch.writeUInt32LE(e.size, 24);
      ch.writeUInt16LE(e.nameBuf.length, 28);
      ch.writeUInt32LE(e.isDir ? 0x00000010 : 0, 38); // DOS directory bit
      ch.writeUInt32LE(e.localOffset, 42);
      put(ch);
      put(e.nameBuf);
    }
    const cdSize = offset - cdOffset;

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    put(eocd);
  } finally {
    fs.closeSync(fd);
  }

  return {
    entries: entries.length,
    files: entries.filter((e) => !e.isDir).length,
    dirs: entries.filter((e) => e.isDir).length,
    bytes: offset,
    path: outFile
  };
}

/** 读 ZIP 中央目录并逐条解压核对 CRC32，用于产物自检（不完整解压到磁盘） */
function verifyZip(zipFile) {
  const buf = fs.readFileSync(zipFile);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP 缺少 EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`第 ${n} 条中央目录头损坏`);
    const flag = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if ((flag & 0x0800) === 0 && /[^\x00-\x7f]/.test(name)) {
      throw new Error(`中文条目 ${name} 未置 UTF-8 标志位`);
    }
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`${name} 的本地头损坏`);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(dataStart, dataStart + csize);
    const raw = method === 8 ? zlib.inflateRawSync(data) : data;
    if (raw.length !== size || crc32(raw) !== crc) throw new Error(`${name} CRC32 校验失败`);
    names.push(name);
    entries.push({ name, method, csize, size, crc, dataStart });
    p += 46 + nameLen + extraLen + commentLen;
  }
  // read(name) 让自检脚本能按需取出某个小文件的内容，不必把整包解到磁盘
  const read = (name) => {
    const e = entries.find((x) => x.name === name);
    if (!e) return null;
    const data = buf.subarray(e.dataStart, e.dataStart + e.csize);
    return e.method === 8 ? zlib.inflateRawSync(data) : data;
  };
  return { count, names, bytes: buf.length, read };
}

module.exports = { createZip, verifyZip, crc32 };
