# 全历史安全审计与历史清理（2026-10-09）

仓库转为公开时做的一次全量敏感信息审计，随后的 gemini client secret 历史重写记录。

**本文只记录位置与性质，不记录密钥原值。**

## 范围与方法

| 项 | 值 |
| --- | --- |
| 提交数 | 34（单分支 `main`；无 tag、无 stash、无 notes） |
| 被跟踪文件 | 314 |
| 历史 blob | 1094 |
| 工具 | gitleaks 8.30.1（`git` 全历史 + `dir` 工作区）、自写正则 + 香农熵扫描、个人信息扫描、对象库全量 `cat-file` 复查 |

## 结论：无个人凭证泄漏

以下均已确认干净：

- 无 refresh_token / access_token / cookie / session / 凭证 JSON 进过库
- 无私钥（只有一把 RSA **公钥**：`channels/qoder[cn]/src/upstream.ts`，安全）
- 无本机路径与用户名（`C:\Users\<user>`、`/home/`、`/Users/` 零命中）
- 文件内容零邮箱；提交者身份 `bluechonk <bluechonk@qq.com>` 属 git 元数据
- 无真实手机号（`13800138000`、`19912345678`、`tok-*`、`plain-key-1234` 全是测试 fixture）
- IP `169.254.198.161` 是 link-local 地址，被当作伪造的 `cosy-clientip` 头值，非真实 IP
- 无 AWS / JWT / Slack / GitHub token（gitleaks 全规则 + 熵扫描双重确认）

## 已提交的敏感项：app 级密钥清单

均为**随官方客户端分发的 app 级标识**（非用户凭证、非个人数据），但字面命中
「accesskey / secret key」，需按【开发规范】3/4 处置。

| 位置 | 常量 |
| --- | --- |
| `channels/loomy/src/cred.ts` | `ACCESS_KEY_ID` / `ACCESS_KEY_SECRET` / `APP_ID` / `WECHAT_APP_ID` |
| `channels/raccoon/src/cred.ts` | `PHONE_CIPHER_SECRET` |
| `channels/trae/src/cred.ts` | `CLIENT_ID` / `APP_ID` |
| `channels/cline/src/cred.ts` | `WORKOS_CLIENT_ID` |
| `channels/codearts/src/cred.ts` | `CLIENT_ID` |
| `channels/catpaw/src/upstream.ts` | `M_APPKEY` |
| `channels/qoder[cn]/src/upstream.ts` | `CUSTOM_ALPHABET`（自定义 Base64 混淆表，**非密钥**） |

**为什么不能塞进 `credentials.json`**：该文件存的是**登录的产物**（用户级 token），
而这些常量是**应用级签名密钥** —— loomy 的 `ACCESS_KEY_SECRET` 用于给登录请求本身
签名（`Authorization: account {ak}:{hmac}`），**在登录之前就要用**，不可能是登录产物，
且所有用户共用同一值。项目既有惯例即：app 级常量进代码，用户凭证进 `credentials.json`。

**待办**：按【开发规范】4 改为环境变量（先例：gemini 的 `CMDC_PAK_GOOGLE_*` 覆盖）。
因与并行改造（日志英文化）占用同一批文件，待其收工后统一处理。

> 复核（2026-10-10）：上述常量**仍未加环境变量覆盖**，待办仍然有效；日志英文化改造已完成
> （`2819f91`），现在可以直接动这批文件了。

## gemini client secret 的历史重写（已执行）

`GEMINI_DEFAULT_CLIENT_SECRET` 的原值曾出现在 4 处（2 条路径 × 2 个时代）：

```
channels/gemini-bridge/src/cred.ts   (b12b786 时代)
channels/gemini/src/cred.ts          (6114a72 时代)
docs/protocols/gemini/PROTOCOL.md    (6114a72 时代)
docs/archive/gemini/protocol/PROTOCOL.md  (重写后现行；该文件已随归档清理删除)
```

**操作**：`uvx git-filter-repo --replace-text` 对全部提交做字面替换，随后强推。

**后果（务必知晓）**：

- **全部 34 个提交的 hash 已改变**。旧 HEAD `34b4d7d` → 新 `851d565`；根
 `.gitattributes` 补齐后为 `7cb929d`。
- 任何基于旧历史的本地提交，推送时会因 non-fast-forward 被拒，需 `git pull --rebase`。
- 备份（含旧历史与原 secret）留在仓库外：`../model-bridge-backup.bundle`。

**验证**：全历史 `git log --all -S` 无命中；对象库全量 `cat-file` 复查无命中
（含不可达对象）；新旧 HEAD 树逐字节比对仅差该 1 行。

** 两个未闭合的局限**：

1. **GitHub 上旧提交仍可按 SHA 读取**（实测 `34b4d7d` 仍返回含原值的文件）。
  改写只让 commit 不可达，GitHub 不立即回收对象 —— 需向 GitHub Support 提工单
  申请回收不可达数据；已 clone 的人与 fork 也各自留有一份。
2. **必须轮换该 client secret**（在 Google 侧重置）。这是唯一彻底的处置。

## 未提交但本地存在

`channels/catpaw/reference/`（431 文件）与 `channels/qoder/reference/`（316 文件）
是 clone 的第三方实现（catpaw2api、thief-neko、qoder2api 等 7 个）。

- 被逐渠道 `.gitignore` 的 `reference/` 规则拦住，全历史 `--diff-filter=A` 命中 0 次，
 **确认从未提交**，公开仓库内没有。
- 但其中含第三方代码自带的密钥：**不要备份或同步该目录到别处**。

## 【开发规范】符合性

| 规范 | 状态 |
| --- | --- |
| 1 文本一律 LF 入库 | 索引内 CRLF = 0 |
| 2 项目必须有 `.gitattributes` | 已补根 `.gitattributes`（`7cb929d`） |
| 3 严禁提交 accesskey / secret key 等 | 见上表，待处置 |
| 4 敏感内容改环境变量 / 密钥服务 | 待处置（2026-10-10 复核仍未动） |
| 5 提交前自查 + 误提交要撤销 / 轮换 / 清理历史 | 清理与重写已完成；**轮换待办** |
| 6 注释中文 | 符合 |
| 9 日志英文 | 已完成（`2819f91`） |
| 流程 4 开发进程落档 docs | 本文 |
