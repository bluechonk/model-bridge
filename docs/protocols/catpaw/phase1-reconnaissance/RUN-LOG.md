# Phase 1 · 侦察（Reconnaissance）

> **实现语言（2026-10-07）**：本阶段现由 Python 实现 —— `src/catpaw_bridge/recon.py`，
> 命令行入口 `uv run catpaw-recon`。下文原始输出来自 TS/Node 版脚本（tag `v0.3.0-ts`）；
> 结论与证据等级不变，详见 [../README.md](../PROTOCOL.md)。

## 目标

在完全不碰任何凭据内容的前提下，先回答"东西在哪"：妙手装在本机哪个目录、应用主体是什么形态与版本、Electron 的用户数据（userData）目录在哪、里面有哪些候选落点文件，以及此刻桌面端有没有在跑。本阶段刻意把"定位"与"取值"彻底分开——只 stat、只读非敏感的 `product.json`、只列进程，不读任何凭据文件的内容。

## 方法与命令

执行命令：

```text
npm run recon          # 等价于 node scripts/recon.ts
```

入口 `scripts/recon.ts` 调用 `reconnaissance()` + `formatReconReport()`（`src/phase1-reconnaissance/index.ts`），把一次快照打到 stdout。本阶段的行为边界 `[代码]`：

| 动作 | 实现 | 是否读内容 | 是否写盘 |
| --- | --- | --- | --- |
| 探路径（安装目录 / app.asar / product.json / SDK / CLI 包 / userData） | `probePath()`，只做 `statSync`，取存在性、类型、大小、mtime（`src/utils/probe.ts`） | 否 | 否 |
| 读 `resources\product.json` | `readProductInfo()`，只取 8 个字符串字段 | 是（非敏感元数据） | 否 |
| 列进程 | `detectProcesses()`，win32 下执行 `tasklist /FO CSV /NH`，按 `/catpaw\|catx\|paw\|妙手/iu` 过滤镜像名 | 否 | 否 |
| 组装路径 | `catPawLayout()`（`src/utils/paths.ts`）：`%LOCALAPPDATA%\妙手`、`%APPDATA%\catpaw-moon`、`%USERPROFILE%\.meituan-catpaw` | 否 | 否 |

三个根路径都可用环境变量覆盖（`CATPAW_INSTALL_DIR` / `CATPAW_USER_DATA_DIR` / `CATPAW_HOME_DIR`），便于在别的机器上复现 `[代码]`。

本次运行的原始输出留存于 `.tmp\runlogs\recon.txt`，下面「原始输出」一节的内容全部取自该文件。

### 为什么先做只读侦察

1. **分离定位与取值。** 先知道"哪些文件值得看"，再决定"要不要读内容"；避免在还不知道落点时就碰到凭据原文。侦察阶段产出的元数据表，正是 Phase 2 枚举落点的输入。
2. **判断后续阶段的可行性。** 本课题 Phase 4 要做静态检索，前提是主程序是一个可被解包、可被字符串检索的归档——必须先确认 `app.asar` 存在且量出体积。
3. **前提：`app.asar` 不压缩。** Electron 用 `app.asar` 把主进程与渲染层 JS 打进一个归档，内容是各文件按偏移拼接、**不压缩**存放，因此 JS 以明文躺在归档里，可以直接用字符串检索反查实现常量，既不用运行程序、也不用做内存 dump。这是 Phase 4 的前提 `[推断]`：本阶段只量到归档大小，并未打开归档验证其内部编码；`src/utils/paths.ts` 与 `src/phase3-format-analysis/index.ts` 的注释都建立在"Phase 4 从 `app.asar` 里读到实现常量"这一前提之上。
4. **顺带拿到进程状态。** "桌面端此刻在不在跑"直接决定凭据文件是否被锁定/正在写入，是后续所有读取操作的一个安全前提 `[实测]`。

## 原始输出（节选）

```text

=== Phase 1 · 侦察快照 ===
  时间                     2026-10-06T02:53:50.292Z
  平台                     win32

=== 安装布局 ===
  安装目录                   OK  C:\Users\bluechonk\AppData\Local\妙手
  app.asar               OK  381.1 MiB
  Agent SDK              OK  C:\Users\bluechonk\AppData\Local\妙手\resources\app.asar.unpacked\node_modules\@catpaw\agent-sdk
  CLI 包                  OK  189.9 KiB

=== product.json ===
  version                2026.0923.1905
  commit                 9a497699f6cb7f92f33d64b328846b975578a230
  applicationName        catpaw-moon
  dataFolderName         .meituan-catpaw
  cliCommandName         paw
  appId                  com.catx.catpaw

=== userData 候选文件（仅元数据） ===
状态  大小     修改时间                 路径
OK  326 B  2026-10-03 15:17:18  C:\Users\bluechonk\AppData\Roaming\catpaw-moon\catx-credential.json
OK  38 B   2026-10-03 15:17:13  C:\Users\bluechonk\AppData\Roaming\catpaw-moon\catx-auth-provider.json
OK  92 B   2026-10-03 15:17:13  C:\Users\bluechonk\AppData\Roaming\catpaw-moon\catx-enterprise-token.json
OK  43 B   2026-10-06 01:53:40  C:\Users\bluechonk\AppData\Roaming\catpaw-moon\catx-scope-pointer.json
OK  57 B   2026-10-06 01:53:43  C:\Users\bluechonk\AppData\Roaming\catpaw-moon\catpaw-uuid
OK  490 B  2026-10-03 15:16:09  C:\Users\bluechonk\AppData\Roaming\catpaw-moon\Local State
OK  442 B  2026-10-06 01:53:43  C:\Users\bluechonk\.meituan-catpaw\auth.json

=== 进程 ===
  # 无

=== 结论 ===
  - 安装目录存在：C:\Users\bluechonk\AppData\Local\妙手
  - 主程序归档 app.asar 381.1 MiB，版本 2026.0923.1905
  - Electron userData 存在：C:\Users\bluechonk\AppData\Roaming\catpaw-moon
  - 未检测到妙手进程（桌面端未运行）
```

## 结论

1. 安装目录 `C:\Users\bluechonk\AppData\Local\妙手` 存在 `[实测]`。
2. 主程序归档 `resources\app.asar` 存在，大小 **381.1 MiB** `[实测]`；同目录下 `app.asar.unpacked\node_modules\@catpaw\agent-sdk` 存在，说明该 SDK 是 unpacked 落盘的 `[实测]`。
3. 随包 CLI `resources\cli\catpaw-cli.js` 存在，189.9 KiB `[实测]`。
4. 版本 `2026.0923.1905`，commit `9a497699f6cb7f92f33d64b328846b975578a230` `[实测]`。
5. `product.json` 的身份字段：`applicationName=catpaw-moon`、`dataFolderName=.meituan-catpaw`、`cliCommandName=paw`、`appId=com.catx.catpaw` `[实测]`。`product.json` 里还有 `win32MutexName`（值 `CatPawAppMutex`）与 `cliSocketFolder`：字段名与读取逻辑见 `readProductInfo()` `[代码]`，但渲染函数没有把它们打进输出，所以原始输出里看不到这两个值——引用其值时须直接读 `product.json`，本 RUN-LOG 不为该值背书（见「踩坑与修正」第 2 条）。
6. Electron userData 为 `C:\Users\bluechonk\AppData\Roaming\catpaw-moon`，存在 `[实测]`；它与 `applicationName` 同名，符合 Electron 默认把 userData 放在 `%APPDATA%\<applicationName>` 的行为 `[推断]`（`paths.ts` 亦按此硬编码目录名）。
7. `dataFolderName=.meituan-catpaw` 与 CLI 侧落点 `C:\Users\bluechonk\.meituan-catpaw\auth.json` 目录名一致 `[实测]`+`[推断]`：CLI 与桌面端共用同一个 home 目录约定。
8. userData 下 7 个候选文件全部存在，大小与修改时间见上表 `[实测]`；其中 `catx-credential.json`（326 B）与 `~\.meituan-catpaw\auth.json`（442 B）是本课题后续的两个核心落点 `[实测]`。
9. 按 `/catpaw|catx|paw|妙手/iu` 过滤 `tasklist` 输出的结果为**空** `[实测]`。该过滤器经修正后已覆盖主程序 exe 名 `妙手.exe`（见「踩坑与修正」第 3 条），因此本次可以读成"**桌面端此刻未运行**" `[实测]`；但"没有进程"仍不等于"文件没被锁定"（任何以其他镜像名托管的进程、或句柄继承都可能锁文件），后续读取一律按"文件可能正在被写"处理。
10. 本阶段的所有路径与判定均为只读操作，未读取任何凭据文件内容、未写盘 `[代码]`。

## 踩坑与修正

> 本节三条坑在撰写本文时都**已在代码里修掉**，下面是"当时的错误 → 怎么发现 → 已改成什么"的记录。

1. **单位口径不一致（MB vs MiB），不是数据冲突。** `src/utils/paths.ts` 的注释原写 app.asar 约 399 MB，实测输出是 381.1 MiB。`formatBytes()`（`src/utils/probe.ts`）以 1024 为进制、后缀写 MiB；381.1 MiB × 1024² ≈ 399.6 MB（十进制），两者是同一体积的两种口径。**已把注释改为 `381.1 MiB / 399,639,418 字节`**（直接写字节数，杜绝口径歧义）；本 RUN-LOG 一律以实测的 381.1 MiB 为准 `[代码]`+`[推断]`。
2. **"输出里没有" ≠ "文件里没有"。** `ProductInfo` 一共读了 8 个字段（含 `win32MutexName`、`cliSocketFolder`），而 `formatReconReport()` 只打印 6 个。要确认后两个字段的值，必须直接读 `product.json` 或改渲染函数，不能因为侦察输出里没有就当作不存在 `[代码]`。
3. **进程过滤器漏掉了主程序本身（本阶段最需要修正的一条）。** `detectProcesses()` 原来用 `/catpaw|catx|paw/i` 匹配 `tasklist` 的镜像名，而本机主程序的可执行文件名为 `妙手.exe`，**不匹配**该正则——也就是说，即使桌面端正开着，这条检查也会给出"无进程"。发现方式：写 RUN-LOG 时对安装目录补做了一次只读列举（该次列举未随脚本落盘）确认了文件名：

   ```text
   安装目录根下：妙手.exe        ← 不含 catpaw / catx / paw 字样
   ```

   **已修正**：过滤词加入 `妙手`（`/catpaw|catx|paw|妙手/iu`，同时覆盖 `catpaw-cli.exe` 与 `妙手.exe`），并重跑 `npm run recon` 复核——修正后仍为空，故"桌面端此刻未运行"这次可以成立 `[实测]`。这条也提醒：**任何"文件未被锁定"的假设都不能建立在"没有进程"之上**。
4. **时间口径。** `formatReconReport()` 的时间戳用 `new Date().toISOString()`（UTC）；`formatTime()` 的文档注释原写"本地时区"、实现却是 `toISOString()` 截断——注释与实现不一致。**已把注释改成 UTC（ISO 8601）**。所以表里的 `2026-10-03 15:17:18` 是 UTC，换算北京时间要 +8 小时 `[代码]`+`[推断]`。

## 下一步

Phase 2 拿本阶段的元数据表作为输入，逐个落点枚举其结构（顶层键名 / SQLite 表名），判定谁真正承载凭据、是明文还是密文。
