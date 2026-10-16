/**
 * OrcaTerm 模型目录 —— **尚未实现（桩）**。
 *
 * 上游没有可对标的「模型列表端点」证据（Agent 支持的是用户自配的第三方
 * 编码套餐，见 docs/PROTOCOL.md §3.3），且对话协议本身未确认，故不臆造目录。
 *
 * 按 CONTRACT-TS §7：桩函数立即抛错（不返回空数组 —— 那会被池视图当成
 * 「该渠道没有模型」，而不是「该渠道还没实现」）。
 *
 * 注意：`poolCandidates()` 对 `exposedIds()` 抛错做了 catch，会安全跳过本渠道，
 * 所以这里的抛错不会拖垮仓库级池视图。
 */

const HINT =
  "尚未实现：OrcaTerm 模型目录；对话协议与模型端点待抓包确认，" +
  "见 channels/orcaterm/docs/PROTOCOL.md §3";

export function exposedIds(): never {
  throw new Error(`OrcaTerm catalog.exposedIds ${HINT}`);
}

export function resolveModel(_name: string): never {
  throw new Error(`OrcaTerm catalog.resolveModel ${HINT}`);
}
