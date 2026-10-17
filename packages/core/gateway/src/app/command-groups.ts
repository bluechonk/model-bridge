/**
 * 命令组的对外门面：`model` 组与渠道动词的实现分别在 `commands/` 下的两个文件，
 * 本文件只做 re-export —— 保持 `index.ts` 与外部调用方的符号面不变。
 *
 * - `commands/model-group.ts`：`model list` / `model usage`、本地目录、可登录渠道列表
 * - `commands/channel-verbs.ts`：渠道动词（login / status / models / billing / accounts / …）
 */

export {
  type CommandContext,
  listLocalModels,
  listPoolModels,
  listLogins,
  runModelGroup,
  showPoolUsage,
} from "./commands/model-group.js";

export { CHANNEL_VERBS, isChannelVerb, runVerb } from "./commands/channel-verbs.js";
