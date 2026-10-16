/**
 * 模型家族白名单：**放行全部模型**（全模型池模式）。
 *
 * 历史：曾限制为 `(deepseek|glm) && flash`，现已放宽为全部模型。
 * 如需重新限制，往 `FAMILY_ALLOWLIST` 里加正则（如 `/qwen/i`）。
 *
 * ## 为什么放在共享层
 *
 * 「池子里放哪些模型」是**网关策略**，不是某个渠道的协议事实 ——
 * 每个渠道的目录都由上游决定，而策略由使用方决定。放在共享层的好处：
 * 一次改动覆盖全部渠道，且将来新增渠道自动遵守同一策略。
 *
 * ## 怎么改
 *
 * - 想限制家族：往 `FAMILY_ALLOWLIST` 里加正则（如 `/deepseek/i`）
 * - 想限制型号：往 `REQUIRED_ALLOWLIST` 里加正则（如 `/\bflash/i`）
 * - 想临时排查：设 `MODELMUX_ALLOW_ALL_MODELS=1` 绕过白名单（不改代码）
 */

/** 放行的模型**家族**（任一命中即可）。空数组 = 放行全部。 */
export const FAMILY_ALLOWLIST: RegExp[] = [];

/** 必须**同时**命中的型号标记（全部命中才算过）。空数组 = 不强制型号。 */
export const REQUIRED_ALLOWLIST: RegExp[] = [];

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
  if (process.env["MODELMUX_ALLOW_ALL_MODELS"] === "1") return true;
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
  if (process.env["MODELMUX_ALLOW_ALL_MODELS"] === "1") return "all (MODELMUX_ALLOW_ALL_MODELS=1)";
  if (FAMILY_ALLOWLIST.length === 0) return "all";
  const families = FAMILY_ALLOWLIST.map((re) => re.source).join(" | ");
  if (REQUIRED_ALLOWLIST.length === 0) return families;
  const required = REQUIRED_ALLOWLIST.map((re) => re.source).join(" | ");
  return `${families} && ${required}`;
}
