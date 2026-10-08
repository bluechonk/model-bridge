/**
 * 渠道目录里的名字 → 该渠道的上游 slug。
 *
 * 对外 id 与路由在 `pool-targets.ts`：客户端只看到三个公共模型 id，
 * 落到哪家渠道由网关按账本决定。本文件只负责最后一步转换。
 *
 * **大小写**：解析做**大小写不敏感**匹配，但拿**目录里的原始写法**去走渠道自己的
 * `resolveModel()` —— 上游 slug 可能大小写敏感（例如 TRAE 上游认
 * `DeepSeek-V4-Flash`，不认 `deepseek-v4-flash`）。
 */

import type { Channel } from "./channel.js";

/** 把客户端发来的模型名解析为该渠道的上游模型名（大小写不敏感）。 */
export function resolvePoolModel(channel: Channel, name: string): string {
  const wanted = name.toLowerCase();
  const hit = channel.catalog.exposedIds().find((id) => id.toLowerCase() === wanted);
  return channel.catalog.resolveModel(hit ?? name);
}
