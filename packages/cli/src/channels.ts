/**
 * 仓库级渠道清单：**唯一** import 全部渠道模块的地方。
 *
 * 各渠道包（目录 `packages/channels/<cid>/`，包名 `@modelmux/<cid>`）的 `index.ts` 在模块
 * 加载时 `setChannel()`（副作用），故这里只要把渠道包各 import 一遍，注册表里就有
 * 全部渠道。共享包本身不 import 任何渠道（见 `@modelmux/gateway` 的 `channel.ts`），
 * 所以这一层必须独立存在。
 *
 * 新增渠道时**只需在这里加一行 import**（外加仓库根 `workspaces`）。
 */

import "@modelmux/catpaw";
import "@modelmux/codearts";
import "@modelmux/lobsterai";
import "@modelmux/loomy";
import "@modelmux/orcaterm";
import "@modelmux/qoder";
import "@modelmux/qodercn";
import "@modelmux/raccoon";
import "@modelmux/traecn";
import "@modelmux/workbuddy";
import "@modelmux/workbuddyai";
