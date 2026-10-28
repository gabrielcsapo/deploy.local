import { deflateSync } from 'node:zlib';
const digits = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
};
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4),
    checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}
export function icon(
  size,
  { app = false, failing = false, warning = false, offline = false, count = 0, dark = false } = {},
) {
  const label = Number.isInteger(count) && count > 0 ? (count > 99 ? '99+' : String(count)) : '';
  const width = Math.round((size * (20 + label.length * 7)) / 20);
  const pixels = Buffer.alloc((width * 4 + 1) * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < width; x++) {
      const px = (x / size) * 20,
        py = (y / size) * 20;
      const round = (left, top, right, bottom, radius) => {
        const dx = Math.max(left + radius - px, 0, px - right + radius);
        const dy = Math.max(top + radius - py, 0, py - bottom + radius);
        return (
          px >= left &&
          px <= right &&
          py >= top &&
          py <= bottom &&
          dx * dx + dy * dy <= radius * radius
        );
      };
      let color = [0, 0, 0, 0];
      if (app && round(1, 1, 19, 19, 4)) color = [108, 64, 204, 255];
      const ink = app
        ? [255, 255, 255, 255]
        : offline
          ? [120, 120, 120, 255]
          : dark
            ? [243, 242, 245, 255]
            : [34, 33, 38, 255];
      if (!app && round(3, 3, 17, 17, 4) && !round(4.5, 4.5, 15.5, 15.5, 2.5)) color = ink;
      const ring = Math.hypot(px - 9.4, py - 11);
      if ((ring <= 3 && ring >= 1.5) || (px >= 10.8 && px <= 12.3 && py >= 5.8 && py <= 14))
        color = ink;
      if ((failing || warning || offline) && Math.hypot(px - 16, py - 3) < 2.8)
        color = failing ? [180, 35, 24, 255] : warning ? [138, 82, 8, 255] : [103, 99, 111, 255];
      if (label && px >= 20) {
        const letter = Math.floor((px - 20) / 7);
        const column = Math.floor(((px - 20) % 7) / 1.7);
        const line = Math.floor((py - 5.75) / 1.7);
        if (digits[label[letter]]?.[line]?.[column] === '1') color = ink;
      }
      const index = y * (width * 4 + 1) + 1 + x * 4;
      color.forEach((value, channel) => {
        pixels[index + channel] = value;
      });
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
