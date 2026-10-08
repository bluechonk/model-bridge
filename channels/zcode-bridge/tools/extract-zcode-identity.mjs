/**
 * 从渠道包的 `zcode-identity.ts` 程序化提取官方身份块。
 *
 * 为什么要程序化提取而不是手抄：身份块是 3012 准入的唯一开关，
 * 且上游策略与它强耦合。手抄容易引入偏差（多一个空格、少一个换行都可能
 * 改变判据），而 3012 有**账号冷却惩罚**（30 分钟；24h 内第 3 次起 24h；5 次停用）
 * ——调试代价极高。渠道包本身的注释也记录了同样的取舍：
 * 「本仓库按程序化提取落地，避免手抄引入偏差」。
 *
 * ⚠ 解析必须**尊重字符串状态**：stable 段里含 markdown 链接语法
 * `[label](url)` 与 `::code-comment{...}`，裸找 `]` 会在字符串内部截断
 * （实测踩坑：第一版这样写，stable 段一个都没提取到）。
 *
 * 用法：node extract-zcode-identity.mjs <zcode-identity.ts> [输出 .json]
 */

import fs from "node:fs";

const source = process.argv[2];
if (!source) {
  console.error("用法: node extract-zcode-identity.mjs <zcode-identity.ts> [out.json]");
  process.exit(2);
}

const text = fs.readFileSync(source, "utf8");

/** 从 `start` 处的引号开始，按转义规则走到收尾引号，返回 [原文, 结束下标]。 */
function readString(from) {
  let i = from;
  while (i < text.length && text[i] !== '"' && text[i] !== "'") i += 1;
  if (i >= text.length) return null;
  const quote = text[i];
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === "\\") {
      j += 2;
      continue;
    }
    if (text[j] === quote) break;
    j += 1;
  }
  const raw = text.slice(i, j + 1);
  return { value: JSON.parse(raw), end: j + 1 };
}

/** 取出单条字符串常量。 */
function singleLiteral(name) {
  const start = text.indexOf(`export const ${name}`);
  if (start < 0) throw new Error(`找不到 ${name}`);
  const found = readString(text.indexOf("=", start));
  if (!found) throw new Error(`${name} 不是字符串字面量`);
  return found.value;
}

/**
 * 取出字符串数组。
 *
 * ⚠ 必须从 **`=` 之后**找开括号：声明行是
 * `export const X: readonly string[] = [` —— 类型注解里的 `string[]`
 * 含一对更早的方括号，从声明行开头找 `[` 会命中它，
 * 然后立刻撞上配对的 `]` 而误判数组为空（实测踩坑：第一版这样写，
 * stable 段一个都没提取到）。
 */
function stringArray(name) {
  const start = text.indexOf(`export const ${name}`);
  if (start < 0) throw new Error(`找不到 ${name}`);
  const eq = text.indexOf("=", start);
  if (eq < 0) throw new Error(`${name} 没有赋值`);
  const open = text.indexOf("[", eq);
  if (open < 0) throw new Error(`${name} 不是数组`);

  const out = [];
  let i = open + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "]") break; // 非字符串状态下的 ] 才是数组结尾
    if (ch === '"' || ch === "'") {
      const found = readString(i);
      if (!found) break;
      out.push(found.value);
      i = found.end;
      continue;
    }
    i += 1;
  }
  return out;
}

const cliPrefix = singleLiteral("OFFICIAL_CLI_PREFIX");
const stable = stringArray("OFFICIAL_STABLE_SECTIONS");

const stableChars = stable.reduce((sum, s) => sum + s.length, 0);
const result = {
  cliPrefix,
  stable,
  stats: {
    cliPrefixChars: cliPrefix.length,
    stableSections: stable.length,
    stableChars,
    totalChars: cliPrefix.length + stableChars,
  },
};

console.log("提取结果：");
console.log("  cliPrefix:", result.stats.cliPrefixChars, "字符");
stable.forEach((s, i) => {
  console.log(`  stable[${i}]:`, s.length, "字符 |", JSON.stringify(s.slice(0, 55)) + "…");
});
console.log("  合计:", result.stats.totalChars, "字符");

const target = process.argv[3];
if (target) {
  fs.writeFileSync(target, JSON.stringify(result, null, 2) + "\n", "utf8");
  console.log("已写出:", target);
}
