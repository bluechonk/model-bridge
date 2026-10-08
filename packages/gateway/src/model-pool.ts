/**
 * 模型池的对外呈现与解析。
 *
 * **对外 id 恒为小写**：客户端看到的 `<cid>/<模型>` 里，模型部分统一小写 —— 免得用户
 * 面对 `trae/DeepSeek-V4-Flash` / `loomy/GLM-5.3-Flash` / `raccoon/sn-SenseNova-…`
 * 这种大小写混排。cid 本身就是小写。
 *
 * 解析（客户端发来的 id → 上游模型名）做**大小写不敏感**匹配：命中的是"池内 id"，
 * 再拿**目录里的原始写法**去走各渠道自己的 `resolveModel()` —— 上游 slug 可能大小写敏感
 * （例如 TRAE 上游认 `DeepSeek-V4-Flash`，不认 `deepseek-v4-flash`）。
 *
 * 未命中时原样交给渠道（兼容用户直接写上游 slug）。
 */

import type { Channel } from "./channel.js";

/** 池内对外模型 id：小写化、去重、保持目录顺序。 */
export function poolIds(channel: Channel): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of channel.catalog.exposedIds()) {
    const lower = id.toLowerCase();
    if (!lower || seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}

/** 对外限定名：多渠道路由下带 `<cid>/` 前缀（模型部分小写）。 */
export function qualifiedId(cid: string, id: string, multi: boolean): string {
  const lower = id.toLowerCase();
  return multi ? `${cid}/${lower}` : lower;
}

/** 把客户端发来的模型名解析为该渠道的上游模型名（大小写不敏感）。 */
export function resolvePoolModel(channel: Channel, name: string): string {
  const wanted = name.toLowerCase();
  const hit = channel.catalog.exposedIds().find((id) => id.toLowerCase() === wanted);
  return channel.catalog.resolveModel(hit ?? name);
}
