import { crc32, deflateSync } from 'node:zlib';

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE((crc32(Buffer.concat([name, data])) >>> 0));
  return Buffer.concat([length, name, data, sum]);
}

export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const row = width * 4;
  const raw = Buffer.alloc((row + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (row + 1)] = 0;
    rgba.copy(raw, y * (row + 1) + 1, y * row, (y + 1) * row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Turn an uncompressed Windows bitmap into a PNG. Other bitmap layouts fail explicitly. */
export function bmpToPng(input: Buffer): Buffer {
  if (input.length < 26 || input[0] !== 0x42 || input[1] !== 0x4d) throw new Error('bmp');
  const pixelOffset = input.readUInt32LE(10);
  const header = input.readUInt32LE(14);
  let width: number;
  let height: number;
  let bits: number;
  let compression = 0;
  if (header === 12) {
    width = input.readUInt16LE(18);
    height = input.readInt16LE(20);
    bits = input.readUInt16LE(24);
  } else if (header >= 40 && input.length >= 54) {
    width = input.readInt32LE(18);
    height = input.readInt32LE(22);
    bits = input.readUInt16LE(28);
    compression = input.readUInt32LE(30);
  } else throw new Error('bmp');
  const topDown = height < 0;
  height = Math.abs(height);
  if (width < 1 || height < 1 || width > 10000 || height > 10000 || (bits !== 24 && bits !== 32)) throw new Error('bmp');
  if (compression === 3) {
    if (bits !== 32 || input.length < 66) throw new Error('bmp');
    const red = input.readUInt32LE(54), green = input.readUInt32LE(58), blue = input.readUInt32LE(62);
    if (red !== 0x00ff0000 || green !== 0x0000ff00 || blue !== 0x000000ff) throw new Error('bmp');
  } else if (compression !== 0) throw new Error('bmp');
  const stride = Math.ceil(width * (bits / 8) / 4) * 4;
  if (stride > 40000 || pixelOffset + stride * height > input.length) throw new Error('bmp');
  const rgba = Buffer.alloc(width * height * 4);
  let zeroAlpha = bits === 32;
  for (let y = 0; y < height; y++) {
    const source = pixelOffset + (topDown ? y : height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const index = source + x * (bits / 8);
      const pixel = (y * width + x) * 4;
      rgba[pixel] = input[index + 2];
      rgba[pixel + 1] = input[index + 1];
      rgba[pixel + 2] = input[index];
      const alpha = bits === 32 ? input[index + 3] : 255;
      rgba[pixel + 3] = alpha;
      if (alpha !== 0) zeroAlpha = false;
    }
  }
  if (zeroAlpha) for (let pixel = 3; pixel < rgba.length; pixel += 4) rgba[pixel] = 255;
  return encodePng(width, height, rgba);
}

function dosStamp(): { time: number; date: number } {
  const now = new Date();
  const year = Math.min(2107, Math.max(1980, now.getFullYear()));
  return {
    time: (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(),
  };
}

/** Stored-method ZIP so the feedback package opens in a normal archive viewer. */
export function zipStore(files: readonly { name: string; data: Buffer }[]): Buffer {
  const stamp = dosStamp();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    if (!file.name || file.name.includes('\\') || file.name.startsWith('/') || file.name.split('/').includes('..')) throw new Error('图片附件无效。');
    const name = Buffer.from(file.name);
    const sum = crc32(file.data) >>> 0;
    const size = file.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    const localChunk = Buffer.concat([local, name, file.data]);
    locals.push(localChunk);
    centrals.push(Buffer.concat([central, name]));
    offset += localChunk.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
