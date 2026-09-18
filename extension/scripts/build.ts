import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const publicDir = join(root, "public");

mkdirSync(dist, { recursive: true });
mkdirSync(join(dist, "icons"), { recursive: true });

await esbuild.build({
  entryPoints: {
    background: join(root, "src/background.ts"),
    content: join(root, "src/content.ts"),
    inject: join(root, "src/inject.ts"),
    popup: join(root, "src/popup.ts"),
    options: join(root, "src/options.ts"),
  },
  bundle: true,
  outdir: dist,
  format: "esm",
  target: "chrome120",
  sourcemap: true,
  logLevel: "info",
  define: {
    __ABO_DEFAULT_OBSERVER_URL__: JSON.stringify(
      process.env.ABO_DEFAULT_OBSERVER_URL ?? "http://127.0.0.1:3847",
    ),
    __ABO_DEFAULT_API_TOKEN__: JSON.stringify(process.env.ABO_DEFAULT_API_TOKEN ?? ""),
  },
});

for (const file of ["manifest.json", "popup.html", "popup.css", "options.html"]) {
  cpSync(join(publicDir, file), join(dist, file));
}

/** Minimal valid PNG (solid color) without external deps */
function writePng(path: string, size: number, rgb: [number, number, number]) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  function chunk(type: string, data: Buffer) {
    const typeBuf = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crcBuf = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcBuf));
    return Buffer.concat([len, typeBuf, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const idat = deflateSync(raw);
  const png = Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

writePng(join(dist, "icons/icon16.png"), 16, [91, 159, 212]);
writePng(join(dist, "icons/icon48.png"), 48, [91, 159, 212]);
writePng(join(dist, "icons/icon128.png"), 128, [91, 159, 212]);

const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
console.log(`Built ABO extension v${manifest.version} → ${dist}`);
