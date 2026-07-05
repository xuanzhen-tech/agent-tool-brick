/**
 * 构建可分发的 agent-tool 运行时 artifact。
 *
 * artifact 包含面向 host 的命令入口、服务运行时模块、积木元数据和运行时
 * 合同。它不会打包 Node、rg、Python 或浏览器资源等外部运行时二进制。
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { brickDefinition } from "../brick-definition.mjs";
import { createAgentToolRuntimeContract } from "../main/launch-config.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const distDir = path.join(repoRoot, "dist");
const runtimeDir = path.join(distDir, "runtime");
const artifactFileName = `${brickDefinition.id}-${brickDefinition.version}-win32-x64.zip`;
const artifactPath = path.join(distDir, artifactFileName);
const buildMetadataPath = path.join(distDir, "build-artifact.json");
const CRC32_TABLE = createCrc32Table();

console.log("[build-artifact] 1/5 clean dist");
await fs.rm(distDir, { force: true, recursive: true });
await fs.mkdir(runtimeDir, { recursive: true });

console.log("[build-artifact] 2/5 stage runtime files");
await copyFileIntoRuntime(path.join(repoRoot, "src", "cli.mjs"), "src/cli.mjs");
await copyFileIntoRuntime(path.join(repoRoot, "src", "brick-definition.mjs"), "src/brick-definition.mjs");
await writeJsonIntoRuntime("brick-definition.snapshot.json", brickDefinition);

const mainSourceFiles = await readFiles(path.join(repoRoot, "src", "main"));
for (const file of mainSourceFiles) {
  const target = path.join(runtimeDir, "src", "main", ...file.path.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, file.content);
}

await writeJsonIntoRuntime("package.json", {
  name: "@xuanzhen-tech/agent-tool-runtime",
  version: brickDefinition.version,
  private: true,
  type: "module",
  bin: {
    "agent-tool": "./src/cli.mjs"
  }
});

await writeJsonIntoRuntime("runtime-contract.json", createAgentToolRuntimeContract({
  platform: "win32-x64"
}));

const runtimeFiles = await readFiles(runtimeDir);

console.log("[build-artifact] 3/5 create runtime zip");
const artifactBuffer = createZipBuffer(runtimeFiles);
await fs.writeFile(artifactPath, artifactBuffer);

console.log("[build-artifact] 4/5 calculate metadata");
const buildMetadata = {
  brickId: brickDefinition.id,
  version: brickDefinition.version,
  artifactFileName,
  artifactPath,
  size: artifactBuffer.byteLength,
  sha256: sha256(artifactBuffer),
  runtimeDir,
  runtimeFiles: runtimeFiles.map((file) => file.path)
};
await fs.writeFile(buildMetadataPath, `${JSON.stringify(buildMetadata, null, 2)}\n`);

console.log("[build-artifact] 5/5 done");
console.log("[build-artifact] artifact", artifactPath);
console.log("[build-artifact] size", buildMetadata.size);
console.log("[build-artifact] sha256", buildMetadata.sha256);

async function readFiles(directory, root = directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await readFiles(absolutePath, root));
    } else {
      const relativePath = path.relative(root, absolutePath).replaceAll(path.sep, "/");
      files.push({ path: relativePath, content: await fs.readFile(absolutePath) });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function copyFileIntoRuntime(source, targetRelativePath) {
  const target = path.join(runtimeDir, ...targetRelativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}

async function writeJsonIntoRuntime(targetRelativePath, value) {
  const target = path.join(runtimeDir, ...targetRelativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function createZipBuffer(files) {
  const localFileRecords = [];
  const centralDirectoryRecords = [];
  let offset = 0;
  for (const file of files) {
    const nameBuffer = Buffer.from(file.path.replaceAll("\\", "/"), "utf8");
    const data = Buffer.from(file.content);
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localFileRecords.push(localHeader, nameBuffer, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralDirectoryRecords.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + data.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectory = Buffer.concat(centralDirectoryRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(centralDirectoryOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localFileRecords, centralDirectory, end]);
}

function createCrc32Table() {
  return new Uint32Array(256).map((_, index) => {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    return crc >>> 0;
  });
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}
