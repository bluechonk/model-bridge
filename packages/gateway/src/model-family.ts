/**
 * 模型家族白名单：**只把「deepseek 系 / glm 系」的 flash 模型放进模型池**。
 *
 * 两条判据**同时**成立才放行：
 * 1. 家族 ∈ `FAMILY_ALLOWLIST`（deepseek 或 glm）
 * 2. 命中 `REQUIRED_ALLOWLIST`（flash 系）
 *
 * 即 `(deepseek|glm) && flash`。同家族的非 flash（`deepseek-v4-pro`、`glm-5.2`）
 * 与别家的 flash（`qwen3.8-flash`、`gemini-3.8-flash`、`mimo-v2.6-flash`）都被挡在池外。
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
 * | cline | `deepseek/deepseek-v4.1-flash` / `z-ai/glm-5.3-flash` | id 里（斜杠前缀） |
 *
 * ⇒ 只匹配 id 会漏掉 Qoder 那类「目录 key 当 id」的渠道，故两者都要看。
 *
 * ## 策略边界（改前必读）
 *
 * 两道闸门意味着**别家的 flash 型号也会被挡在池外** ——
 * `qwen3.8-flash`、`mimo-v2.6-flash`、`MiniMax-M3.1-Flash-Preview` 等都不再暴露；
 * 没有 deepseek / glm 产品的渠道（cline / qoder）池子会**变空**。
 * 这是刻意的过滤，不是渠道坏了：底层目录 / `catalog.details()` 仍保留完整数据，
 * 只是 `/v1/models` 不放它们出来。
 *
 * ## 怎么改
 *
 * - 想放行全部模型：把 `FAMILY_ALLOWLIST` 置为 `[]`
 * - 想加家族：往 `FAMILY_ALLOWLIST` 里加正则（如 `/qwen/i`）—— 家族之间是**并集**
 * - 想放宽型号要求：把 `REQUIRED_ALLOWLIST` 置为 `[]`（不再强制 flash）
 * - 想临时排查：设 `BRIDGE_ALLOW_ALL_MODELS=1` 绕过白名单（不改代码）
 */

/**
 * 放行的模型**家族**（任一命中即可）。
 *
 * ⚠ 用**前置词边界**而不是裸子串：
 * - 上游写法有 `glm-5.3-flash`、`sn-glm-5-3-flash`、`z-ai/glm-5.3-flashx`、
 *   `~deepseek/deepseek-flash-latest` —— 家族名前面总是 `-` / `/` / `~` / 串首，
 *   这些位置都有词边界，所以 `\b` 覆盖全部真实变体（实测逐条验证过）。
 * - 而裸子串会把 `alglmx-flash`、`glimmer-flash` 这类**不是 GLM 的**名字放进来。
 *   误放行的代价是**把别家模型塞进用户的模型选择器**，比漏掉一个变体严重得多。
 */
export const FAMILY_ALLOWLIST: RegExp[] = [/\bdeepseek/i, /\bglm/i];

/**
 * 必须**同时**命中的型号标记（全部命中才算过）。
 *
 * ⚠ 只加**前置**边界（`\bflash`），**不能**加后置 —— 同系变体靠后缀才认得出：
 * `glm-5.3-flashx`（FlashX）、`~z-ai/glm-flash-latest`（跟随最新），
 * 加后置边界 `\bflash\b` 会把这些变体全丢掉（实测）。
 * 前置边界既覆盖 `glm-5.3-flash` / `deepseek-v4-flash-0731` /
 * `DeepSeek-V4-Flash-Official` / `:batch` 等全部真实写法，也排除 `flashlight` 这类词。
 */
export const REQUIRED_ALLOWLIST: RegExp[] = [/\bflash/i];

/** 判据用的拼接串（各段都是可选，便于调用方只传它有的信息）。 */
export type FamilyHint = string | undefined;

/**
 * 该模型是否放行。
 *
 * 判据 = **家族命中**（`FAMILY_ALLOWLIST` 任一）**且** **型号命中**
 * （`REQUIRED_ALLOWLIST` 全部）。两段都作用在同一个拼接串上。
 *
 * 调用方应把 id、上游 id、展示名都传进来 —— 家族信息不一定在 id 里
 * （Qoder 的 `dfmodel` 只有展示名带 Flash）。
 */
export function isAllowedFamily(...hints: FamilyHint[]): boolean {
  // 排查开关：设了就不做白名单过滤
  if (process.env["BRIDGE_ALLOW_ALL_MODELS"] === "1") return true;
  if (FAMILY_ALLOWLIST.length === 0) return true;
  const haystack = hints.filter((h): h is string => typeof h === "string" && h !== "").join(" ");
  if (!haystack) return false;
  const familyHit = FAMILY_ALLOWLIST.some((re) => re.test(haystack));
  // 空数组 = 不强制型号（只按家族过滤）
  const requiredHit = REQUIRED_ALLOWLIST.every((re) => re.test(haystack));
  return familyHit && requiredHit;
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
  const families = FAMILY_ALLOWLIST.map((re) => re.source).join(" | ");
  if (REQUIRED_ALLOWLIST.length === 0) return families;
  const required = REQUIRED_ALLOWLIST.map((re) => re.source).join(" | ");
  return `${families} && ${required}`;
}
