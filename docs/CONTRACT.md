# Python 渠道契约（**已归档**）

> ⚠ **本文件描述的是旧架构（Python 实现 + 共享模块逐字副本），已不再适用。**
>
> 现行契约见 **[`CONTRACT-TS.md`](./CONTRACT-TS.md)**：所有渠道统一为 TypeScript，
> 共享层收敛到工作区包 `packages/gateway`（`@model-bridge/gateway`），
> 渠道差异通过 `Channel` 注册表注入。

## 为什么归档

本文件对应的做法是：`gateway.py` / `cli.py` / `headless.py` / `auth_flow.py` /
`daemon.py` 在**每个项目里各存一份副本**，靠 `sync_gateway.py` 做字符串替换同步
（`logging.getLogger("zcode-bridge")` → `<cid>-bridge` 之类）。

这带来两个问题：

1. **改一处要重刷 N 份**，副本之间容易漂移；
2. 渠道差异靠**字符串替换**注入，配置散落在模板里，改起来只能靠正则。

现行架构把共享层提取为**唯一一份**工作区包，渠道差异集中到 `src/channel.ts` 的
`BridgeConfig` 一处 —— 字符串替换与副本同步脚本（`scaffold.py` /
`scaffold_ts.py` / `sync_gateway.py`）已全部作废，见 `archive/legacy-scaffolders/`。

## 遗留的 Python 渠道

`catpaw-bridge` 目前仍是 Python 实现，是**最后一个待迁移**的渠道
（它的凭据来自读取其它应用本地文件，正是新契约明确禁止的方案）。
迁移计划见主任务列表 Phase 4；迁移完成后本文件可删除。

---

<details>
<summary>原 Python 契约全文（保留备查，勿据此实现）</summary>

#### `cred.py`

```python
DEFAULT_BASE_URL: str            # 登录/续期用的默认基址
class NotLoggedInError(Exception): ...

@dataclass
class Credentials:
    @property
    def access_token(self) -> str: ...
    @property
    def uid(self) -> str: ...
    @property
    def domain(self) -> str: ...
    def to_dict(self) -> dict: ...
    @classmethod
    def from_dict(cls, data: dict) -> "Credentials": ...

def load() -> Credentials: ...
def save(c: Credentials) -> None: ...
def login(base_url=None, on_url=None, on_status=None) -> Credentials: ...
def refresh(c: Credentials) -> Credentials: ...
def resolve_base_url(realm: str = "auto") -> str: ...
```

#### `upstream.py`

```python
DEFAULT_BASE_URL: str
WIRE: str                        # 'openai' 或 'custom'
DISPLAY_NAME: str
class UpstreamUnauthorized(Exception): ...

def default_config() -> Config: ...
def load_config() -> tuple[Config, bool]: ...
def save_config(cfg: Config) -> None: ...
def chat_url(cfg=None) -> str: ...
def models_url(cfg=None) -> str: ...
def build_headers(credential) -> dict[str, str]: ...
def build_chat_body(req: dict, upstream_model: str) -> dict: ...
def fetch_models(credential) -> dict: ...
def new_translator() -> StreamTranslator: ...   # 仅 WIRE == 'custom'
```

`StreamTranslator` 必须是**增量**翻译器：`feed(chunk: bytes) -> list[bytes]`、
`finish() -> list[bytes]`；用 `codecs.getincrementaldecoder("utf-8")` 跨 chunk
保留半帧，不要用 `chunk.decode()`。

#### `catalog.py`

```python
def exposed_ids() -> list[str]: ...
def resolve_model(name: str) -> str: ...
def details() -> list[dict]: ...   # 可选
```

#### `billing.py`

```python
class CreditsError(RuntimeError): ...
def fetch_credits() -> dict[str, Any]: ...
```

返回形状：`{"total": {remain, size, used, unit, remain_percent},
"packages": [{name, remain, size, days_left}], "claimable": [...]?}`。
「查不到」不能显示成 0 —— 失败抛 `CreditsError`；未登录抛 `cred.NotLoggedInError`。

#### `identity.py`（仅 ZCode）

ZCode 的 3012 风控要求 `system` 以官方身份块开头，由
`tools/extract-zcode-identity.mjs` 提取到 `tools/zcode-identity.json`，运行时加载。
其它渠道无此需求。

</details>
