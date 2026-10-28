import { deflateSync } from 'node:zlib';
import { writeFile } from 'node:fs/promises';
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
function icon(size, { app = false, failing = false, warning = false, offline = false } = {}) {
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
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
      const ink = app ? [255, 255, 255, 255] : offline ? [120, 120, 120, 255] : [34, 33, 38, 255];
      if (!app && round(3, 3, 17, 17, 4) && !round(4.5, 4.5, 15.5, 15.5, 2.5)) color = ink;
      const ring = Math.hypot(px - 9.4, py - 11);
      if ((ring <= 3 && ring >= 1.5) || (px >= 10.8 && px <= 12.3 && py >= 5.8 && py <= 14))
        color = ink;
      if ((failing || warning || offline) && Math.hypot(px - 16, py - 3) < 2.8)
        color = failing ? [180, 35, 24, 255] : warning ? [138, 82, 8, 255] : [103, 99, 111, 255];
      const index = y * (size * 4 + 1) + 1 + x * 4;
      color.forEach((value, channel) => {
        pixels[index + channel] = value;
      });
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
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
export async function buildIcons(directory) {
  for (const [name, options] of Object.entries({
    connected: {},
    failing: { failing: true },
    warning: { warning: true },
    offline: { offline: true },
  }))
    await writeFile(`${directory}/tray-${name}.png`, icon(40, options));
  await writeFile(`${directory}/icon.png`, icon(512, { app: true }));
}
