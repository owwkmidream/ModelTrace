/**
 * 生成指纹库更新通道的 manifest.json。
 *
 * 用途：让桌面客户端在不重新安装程序的前提下更新指纹库。
 * CI 在上游合并完成后运行本脚本，把产物发布到固定地址（raw 分支或 Release 资源），
 * 客户端拉取 manifest 比对 SHA-256，只下载变化的资产。
 *
 * 这样做的前提是「评分算法与指纹库分离」：
 *   - 指纹库（unified_bank.json）变化 → 客户端热更新，无需重新发版
 *   - 评分器（fingerprint-core.js）变化 → 算法变了，客户端会要求升级程序本身
 *
 * 用法：
 *   node desktop/make-manifest.mjs <输出目录>
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

const BANK_PATH = join(REPO, 'data', 'unified_bank.json');
const SCORER_PATH = join(REPO, 'static', 'fingerprint-core.js');

const outDir = process.argv[2] || join(HERE, 'dist');

/**
 * 统一换行为 LF 后再算哈希。
 * 否则同一份文件在 Windows 与 Linux 检出的 SHA 不同，会让客户端误判为有更新。
 */
function canonicalize(buffer) {
  return Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function main() {
  await mkdir(outDir, { recursive: true });

  const bankRaw = await readFile(BANK_PATH);
  const scorerRaw = await readFile(SCORER_PATH);

  const bank = canonicalize(bankRaw);
  const scorer = canonicalize(scorerRaw);

  const bankSha = sha256(bank);
  const scorerSha = sha256(scorer);

  const parsed = JSON.parse(bank.toString('utf8'));

  const manifest = {
    schema: 'modeltrace-asset-manifest/1',
    bank_sha256: bankSha,
    scorer_sha256: scorerSha,
    bank_url: 'unified_bank.json',
    bank_built_at: parsed.built_at ?? null,
    model_count: Array.isArray(parsed.models) ? parsed.models.length : 0,
  };
  // 刻意不写生成的当前时间：manifest 必须对同一批资产产出逐字节相同的内容，
  // 否则 CI 无法用 git diff 校验「产物与源一致」，每次运行都会显示有改动。

  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  // 按统一换行后的内容落盘，保证客户端算出的 SHA 与 manifest 一致
  await writeFile(join(outDir, 'unified_bank.json'), bank);
  await copyFile(SCORER_PATH, join(outDir, 'fingerprint-core.js'));

  process.stdout.write(
    `manifest 已生成：${manifest.model_count} 个模型（${outDir}）\n` +
    `  bank_sha256   = ${bankSha}\n` +
    `  scorer_sha256 = ${scorerSha}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`生成 manifest 失败：${error.message}\n`);
  process.exit(1);
});
