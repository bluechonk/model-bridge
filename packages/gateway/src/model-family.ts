/**
 * 模型家族白名单：**只把 flash 系模型放进模型池**。
 *
 * ## 为什么放在共享层
 *
 * 「池子里放哪些模型」是**网关策略**，不是某个渠道的协议事实 ——
 * 每个渠道的目录都由上游决定，而策略由使用方决定。放在共享层的好处：
 * 一次改动覆盖全部 `<渠道>-bridge`，且将来新增渠道自动遵守同一策略。
 *
 * ## 判据为什么同时看 id 与展示名
 *
 * 各渠道的模型 id 形态不同，家族信息不一定在 id 里：
 *
 * | 渠道 | id 形态 | 家族在哪 |
 * |---|---|---|
 * | codearts / lobsterai | `deepseek-v4-flash` / `glm-5.3-flash` | id 里 |
 * | zcode | `GLM-5.3-Flash` | id 里 |
 * | raccoon | `sn-glm-5-3-flash` / `sn-deepseek-v4-1-flash` | id 里（带渠道前缀） |
 * | trae | `DeepSeek-V4-Flash-Official` | id 里 |
 * | qoder | `dfmodel` / `gfmodel` / `qfmodel` | **只在展示名里**（DeepSeek-Flash / GLM-5.3-Flash） |
 * | workbuddyai | `deepseek-v4.1-flash` | id 里 |
 * | cline | `cline-free/mimo-v2.6-flash` | id 里（斜杠前缀） |
 * | minimax | `MiniMax-M3.1-Flash-Preview` | id 里 |
 * | gemini | `gemini-3.8-flash` | id 里 |
 *
 * ⇒ 只匹配 id 会漏掉 Qoder 那类「目录 key 当 id」的渠道，故两者都要看。
 *
 * ## 策略边界（改前必读）
 *
 * flash-only 意味着**同家族的非 flash 型号会一起被挡在池外** ——
 * `GLM-5.3`、`DeepSeek-V4-Pro`、`MiniMax-M3`、`kimi-k3` 都不再暴露，
 * 哪怕它们的上层目录里有。这是刻意的过滤，不是渠道坏了：
 * 底层目录/`catalog.details()` 仍保留完整数据，只是 `/v1/models` 不放它们出来。
 *
 * ## 怎么改
 *
 * - 想放行全部模型：把 `FAMILY_ALLOWLIST` 置为 `[]`
 * - 想加家族：往数组里加正则（如 `/deepseek/i`），与 flash 取并集
 * - 想临时排查：设 `BRIDGE_ALLOW_ALL_MODELS=1` 绕过白名单（不改代码）
 */

/**
 * 放行的模型家族。
 *
 * ⚠ `/flash/i` 用宽匹配而不是 `/\bflash\b/` —— 模型名里 flash 常靠连字符或
 * 大小写混排（`M3.1-Flash-Preview`、`glm-5.3-flash`、`sn-deepseek-v4-1-flash`、
 * `DeepSeek-V4-Flash-Official`），词边界判定不稳；
 * 而 `flash` 几乎不可能作为别的词的子串出现。
 *
 * ⚠ 同时看 id 与展示名：Qoder 的 `dfmodel` 只有展示名带 Flash。
 */
export const FAMILY_ALLOWLIST: RegExp[] = [/flash/i];

/** 判据用的拼接串（各段都是可选，便于调用方只传它有的信息）。 */
export type FamilyHint = string | undefined;

/**
 * 该模型是否属于放行的家族。
 *
 * 传入的任意一段命中白名单即算通过 —— 调用方应把 id、上游 id、展示名都传进来。
 */
export function isAllowedFamily(...hints: FamilyHint[]): boolean {
  // 排查开关：设了就不做白名单过滤
  if (process.env["BRIDGE_ALLOW_ALL_MODELS"] === "1") return true;
  if (FAMILY_ALLOWLIST.length === 0) return true;
  const haystack = hints.filter((h): h is string => typeof h === "string" && h !== "").join(" ");
  if (!haystack) return false;
  return FAMILY_ALLOWLIST.some((re) => re.test(haystack));
}

/** 按白名单过滤一组模型条目。 */
export function filterAllowedFamily<T>(
  entries: readonly T[],
  hintOf: (entry: T) => FamilyHint[],
): T[] {
  return entries.filter((entry) => isAllowedFamily(...hintOf(entry)));
}

/** 白名单的可读描述（供 `/v1/models` 的响应与状态页展示策略）。 */
export function allowlistSummary(): string {
  if (process.env["BRIDGE_ALLOW_ALL_MODELS"] === "1") return "all (BRIDGE_ALLOW_ALL_MODELS=1)";
  if (FAMILY_ALLOWLIST.length === 0) return "all";
  return FAMILY_ALLOWLIST.map((re) => re.source).join(" | ");
}
