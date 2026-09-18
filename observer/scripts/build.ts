import * as esbuild from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "extension-dist");
const srcExt = path.join(root, "src", "extension");

async function ensureIcons(): Promise<void> {
  const iconDir = path.join(outDir, "icons");
  await fs.mkdir(iconDir, { recursive: true });
  await fs.writeFile(path.join(iconDir, "icon16.png"), createSolidPng(16, 61, 156, 240));
  await fs.writeFile(path.join(iconDir, "icon48.png"), createSolidPng(48, 61, 156, 240));
  await fs.writeFile(path.join(iconDir, "icon128.png"), createSolidPng(128, 61, 156, 240));
}

function createSolidPng(size: number, r: number, g: number, b: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;

  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const i = row + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }

  const compressed = zlib.deflateSync(raw);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

async function build(): Promise<void> {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(srcExt, "background.ts")],
    bundle: true,
    outfile: path.join(outDir, "background.js"),
    format: "esm",
    platform: "browser",
    target: ["chrome110"],
  });

  await esbuild.build({
    entryPoints: [path.join(srcExt, "content.ts")],
    bundle: true,
    outfile: path.join(outDir, "content.js"),
    format: "iife",
    platform: "browser",
    target: ["chrome110"],
  });

  await esbuild.build({
    entryPoints: [path.join(srcExt, "inject.ts")],
    bundle: true,
    outfile: path.join(outDir, "inject.js"),
    format: "iife",
    platform: "browser",
    target: ["chrome110"],
  });

  await esbuild.build({
    entryPoints: [path.join(srcExt, "popup.ts")],
    bundle: true,
    outfile: path.join(outDir, "popup.js"),
    format: "iife",
    platform: "browser",
    target: ["chrome110"],
  });

  await fs.copyFile(path.join(srcExt, "manifest.json"), path.join(outDir, "manifest.json"));
  await fs.copyFile(path.join(srcExt, "popup.html"), path.join(outDir, "popup.html"));
  await ensureIcons();

  const hash = createHash("sha256")
    .update(await fs.readFile(path.join(outDir, "background.js")))
    .digest("hex")
    .slice(0, 8);
  console.log(`[build] extension → ${outDir} (${hash})`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
