/**
 * 仓库级渠道清单：**唯一** import 全部渠道模块的地方。
 *
 * 各 `<cid>-bridge` 的 `index.ts` 在模块加载时 `setChannel()`（副作用），故这里
 * 只要把 12 个包 import 一遍，注册表里就有全部渠道。共享包本身不 import 任何渠道
 * （见 `@model-bridge/gateway` 的 `channel.ts`），所以这一层必须独立存在。
 *
 * 新增渠道时**只需在这里加一行 import**（外加仓库根 `workspaces` 与本包 `dependencies`）。
 */

import "catpaw-bridge";
import "cline-bridge";
import "codearts-bridge";
import "gemini-bridge";
import "lobsterai-bridge";
import "loomy-bridge";
import "minimax-bridge";
import "qoder-bridge";
import "raccoon-bridge";
import "trae-bridge";
import "workbuddy-bridge";
