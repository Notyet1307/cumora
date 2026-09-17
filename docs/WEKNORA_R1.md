# WeKnora 检索工具接入（R1 · kb search，只读）

本轮把本机 WeKnora 部署接进本机 Cumora：**被授权的 agent 可以在会话里调用
`kb search`**，检索运维方指定的那一个知识库，并在回答里给出文档名 + `chunk_id`
依据。本文是本轮的交付说明：范围、配置、启动、验收记录、回滚、已知缺口。

> 名称：**WeKnora 检索工具接入**。它不是一个完整的外部 Agent 接入，也不等于把
> WeKnora 变成 Cumora 的通用知识库平台。

## 1. 本轮范围

做：

- 服务端新增只读 CLI 动词 `kb search "<query>" [--limit N]`；
- 服务端固定知识库范围 / 地址 / 凭据，调用者身份取自 runtime JWT；
- space + agent 双白名单，缺一即拒，默认拒绝；
- 返回真实字段并显式声明"资料而非指令"；
- 审计行、超时 / 响应体 / 条数上限。

不做（本轮明确排除）：

- `ingest` / 删除 / 修改任何知识（只读）；
- `kb list`（如确需，只列出已授权配置）；
- `kb ask`（走 WeKnora RAG 流水线；本轮通过后再评估）；
- 把 WeKnora 变成 MCP server、给 Cumora 加通用 MCP 客户端、上游 PR；
- 兼容模式（`CUMORA_BYOA_ALLOW_UNSANDBOXED`）——没有启用，secure 模式未动；
- K8s / managed 路径；没有改 tier 绕过限额。

## 2. 为什么是服务端动词，而不是 MCP

Cumora 目前**没有外部 MCP 客户端**：仓库没有 MCP 依赖、没有 MCP 表 / API / 设置页，
`server/src/agents/computer/daemon.ts` 里那个 MCP 实现是**反向**的——它给本地
Claude/Codex 提供固定 stdio bridge，只暴露 `cli(argv)` 一个工具。

而 secure BYOA 引擎的沙箱是 fail-closed 的（`engine.ts:1512-1533`：网络 allowlist 为空、
工具白名单只有 `Read,Write,Edit,Glob,Grep,mcp__cumora__cli`）。**agent 唯一的出站通道
就是 `cli` 桥**，所以工具必须落在服务端。

```
agent → mcp__cumora__cli → 本机 shim → file IPC → daemon broker
      → POST /runtime/cli → runCli() → cmdKb() → weknora.ts → WeKnora REST
```

身份由 `/runtime/cli` 注入（`runtime/server.ts:159-187`：剥掉调用方自带的 `--as`，
换成 JWT 里钉住的 agentId），因此 `resolveAs()` 拿到的就是可信运行身份。

## 3. 代码改动

| 文件 | 改动 |
|---|---|
| `server/src/agents/weknora.ts` | 新增：配置读取与钳制、授权判定、HTTP 客户端、响应解析与格式化、审计日志 |
| `server/src/agents/cli.ts` | 新增 `kb` 分发 + `cmdKb()` + help 里的 KNOWLEDGE 段（模型靠 `cumora help` 发现能力） |
| `server/src/env.ts` | 新增 `WEKNORA_*` 配置块（未配置即整体禁用） |
| `server/src/__tests__/agents-weknora.test.ts` | 新增：17 个用例（授权矩阵、请求形状、异常路径、输出诚实性） |

## 4. 配置

### 4.1 Cumora 侧（`~/dev/cumora/.env`）

```bash
WEKNORA_BASE_URL=http://localhost:8180/api/v1
WEKNORA_API_KEY=<retrieve-only key>          # 见 4.2，不要用 full_access
WEKNORA_KB_ID=<唯一允许的知识库 UUID>
WEKNORA_ALLOWED_COMPANY_IDS=personal          # 调用方所属 space 必须在此列表
WEKNORA_ALLOWED_AGENT_IDS=compliance          # 调用方 agent id 必须在此列表
WEKNORA_MAX_CHUNKS=5                          # 返回条数上限（--limit 只能更小）
WEKNORA_TIMEOUT_MS=15000                      # 单次上游超时
WEKNORA_MAX_RESPONSE_BYTES=256000             # 上游响应体上限（超出即拒）
```

三个地址 / 密钥 / KB 变量任一为空即视为"未配置"，动词直接拒绝；
两个 allowlist 任一为空即**无人可用**（没有"放行全部"的写法）。

### 4.2 WeKnora 侧（受限密钥）

用 owner 会话创建一个 **retrieve-only + 单知识库** 的 key（不要用 `full_access`）：

```bash
curl -s -X POST http://localhost:8180/api/v1/tenants/10000/api-keys \
  -H "Authorization: Bearer <owner JWT>" -H 'Content-Type: application/json' \
  -d '{"name":"cumora-kb-readonly","capabilities":["retrieve"],
       "knowledge_base_ids":["<KB UUID>"]}'
# 明文 token 只在响应的 data.token 里出现一次；data.api_key 是库内密文，不能用来调用
```

已验证：该 key 能检索，但 `POST /knowledge-bases` 返回 403（写能力已剥离）。
Cumora 侧固定 KB + WeKnora 侧 key 限 KB 形成双重范围约束——即使 Cumora 配错，
越权 KB 也会被上游以 403 `API key scope does not allow one or more knowledge bases` 拒绝。

### 4.3 Agent 侧

需要两个 agent（本轮已创建）：

- `compliance`（显示名 合规助手）：唯一在 `WEKNORA_ALLOWED_AGENT_IDS` 里的 agent；
- `reporter`（显示名 报告助手）：**不在**白名单里，只能消费会话中明确共享的内容。

> 注意：`POST /api/agents` 的 slug 对纯中文名会塌缩成 `a-`（见第 7 节 friction）。
> 本轮用英文名创建后再改名，规避该缺陷。

## 5. 启动顺序

```bash
# 1) 基础设施（已常驻）
brew services start postgresql@17          # :5432
docker start cumora-redis                  # :6379
~/dev/weknora: docker compose up -d        # WeKnora Web :80 / API :8180

# 2) Cumora 服务端（读取 .env）
cd ~/dev/cumora && npm run dev:all         # API :5181 + Web :5180

# 3) 配对码（owner 会话；UI 里的 You → Computers → Add a computer 等价）
curl -s -X POST http://localhost:5181/api/computers/<computerId>/repair \
  -H "Authorization: Bearer <owner session token>"

# 4) BYOA daemon（secure 模式，需与仓库同版本：本机当前用仓库构建的 0.18.4）
cd ~/dev/cumora && npm --prefix agent-cli run build      # → agent-cli/dist/cli.js
CUMORA_TRIAGE_MODEL=gpt-5.6-luna \
  node agent-cli/dist/cli.js agent computer --pair <code> --server http://localhost:5181
```

`CUMORA_TRIAGE_MODEL` 是必须的：Codex 的 ChatGPT 账号不接受 Cumora 默认的小脑模型
`gpt-5.4-mini`（`The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT
account.`），而 triage 失败**不会 fail-open**，agent 将永远不醒。可用的替代：
`gpt-5.6-luna`（小脑）/ `gpt-5.6-sol`（大脑，实测通过）。同时给 computer 设了
`codex.fastModel = gpt-5.6-luna`（`PUT /api/computers/<id>/engine-defaults`）。

## 6. 验收记录

### 6.1 离线（不经过 agent）

| 用例 | 命令 | 结果 |
|---|---|---|
| 单测 | `node --import tsx --test server/src/__tests__/agents-weknora.test.ts` | 17/17 passed |
| 仓库全量单测 | `npm test` | 1462 tests / 1456 pass / 2 fail —— 两处失败位于 `deployment-release-flow.test.ts`，**在未含本轮改动的干净工作树上同样失败**（已 stash 复验），与 R1 无关 |
| 类型 | `npm run server:typecheck` | 通过 |
| Lint | `npx biome lint server/src/agents/weknora.ts server/src/agents/cli.ts server/src/env.ts server/src/__tests__/agents-weknora.test.ts` | 0 warning |
| 守卫 | `guard:big-brain` / `guard:llm-tracked` / `guard:engine-registry` | 全部 ✅ |
| 正向 | `./bin/cumora kb search "迁移窗口 预算" --as compliance` | 命中《凤凰计划评审纪要.md》`chunk_id=c20cf93e` `score=0.0163` |
| 拒绝：agent | `--as reporter` / `--as atlas` | `agent … 不在授权列表`（审计行 `status=denied`） |
| 拒绝：space | `WEKNORA_ALLOWED_COMPANY_IDS=other-company` | `workspace personal 不在授权列表` |
| 拒绝：KB | `WEKNORA_KB_ID=<另一个库>` / 不存在的 UUID | 上游 403 `API key scope does not allow…` |
| 拒绝：越权参数 | `kb search "…" --kb other-kb` | `不接受参数 --kb：知识库范围、地址与凭据由服务端配置固定`（未触达上游） |
| 异常：鉴权失败 | `WEKNORA_API_KEY=sk-invalid-…` | `上游 HTTP 401（API key 无效或权限不足）`，日志与输出均无密钥原文 |
| 异常：超时 | 指向黑洞监听 + `WEKNORA_TIMEOUT_MS=1500` | `上游超时（1500ms）`，约 1.5s 返回 |
| 异常：不可达 | 指向不可路由地址 | `上游不可达：fetch failed` |
| 无命中 | 格式化与上游空 `data` 两条路径 | 单测覆盖；线上库非空时 hybrid 检索总会返回最近邻，见 7.2 |

### 6.2 真实联调（经过真实 agent / 真实引擎）

| 用例 | 过程 | 证据 |
|---|---|---|
| 引擎可用性 | `agent computer --doctor`（repo 构建） | codex 大脑 ✅；小脑改用 `gpt-5.6-luna` 后 ✅；claude 被版本门禁挡住（见 7.4） |
| 配对与运行 | `--pair <code> --server http://localhost:5181` | 日志 `cumora 0.18.4 · starting comp-0b628de5-798 (engines: codex)`，8 个 agent 全部 `wake-stream connected` |
| 原生 agent 先回一次 | DM 合规助手 | 两条回复；`compliance turn DONE (sse-wake:message.new) — total 15509ms, exit 0` |
| 端到端工具调用 | DM 提问"客户合同含身份证号…处理前需要什么流程？留存多久？" | daemon 日志 `mcp: cumora/cli started/completed` ×4；服务端审计 `[weknora] kb search agent=compliance company=personal kb=c9dd8618… status=ok hits=2 req=…` |
| 回答质量 | 同一次回答 | 中文、逐条给流程与留存期限，附《数据处理合规操作手册-合成测试数据.md》`chunk_id=ed5d4d38…` 与原文片段；并主动声明该资料是合成测试数据、不能当真实制度 |
| 协作（报告助手） | 群 `g-fffc2f0a`（yetone + compliance + reporter）：合规助手分两条补齐依据 → 报告助手复核并整理 | 报告助手先指出"内容被截断、无法按完整成果验收"，补齐后输出"验收通过"并附范围提醒；全程**没有**任何 `agent=reporter` 的 kb 审计行 |
| 只读边界 | 越权调用尝试 | 未授权 agent / 越权 KB / 越权参数全部拒绝（见 6.1） |

测试资料均为**合成数据**（`凤凰计划评审纪要.md`、`数据处理合规操作手册-合成测试数据.md`），
上传到本机 WeKnora，文档内已注明不对应任何真实组织制度。

## 7. 已知缺口（如实记录）

1. **只读且仅一个动词**：没有 ingest / 删除 / `kb list` / `kb ask`。下一步评估 `kb ask`
   时需要先决定"由谁拼答案"（agent 用片段自答 vs WeKnora RAG 成稿）。
2. **"命中 N 条" ≠ 相关**：WeKnora 的 hybrid 检索对任何非空库都会返回最近邻
   （实测问"量子退相干时间常数"仍返回 1 条 `score≈0.016`）。`score` 是相似度分数，
   不是正确率——输出里已标注，但 agent 仍可能把弱命中当依据。阈值化留给下一轮。
3. **群聊里的长消息会被截断**：报告助手只能看到合规助手 835 字消息的前约三分之一，
   因此需要对方拆条重发才能完成整理。这是 inbox 侧的既有行为，不是本工具引入的。
4. **claude 引擎不可用**：本机 `claude 2.1.212` 低于 Cumora secure 最低要求 2.1.248
   （`unknown option '--restricted'`），本轮只用 codex。升级 claude 后 secure 双引擎可用。
5. **daemon 从 supervised 换成前台进程**：仓库版本 0.18.4 与 npm 上的 0.18.3 不一致，
   本轮改用仓库构建（`CUMORA_VERSION` 正确上报为 0.18.4），并把原 launchd plist 移到了
   `~/.cumora/rollback/`。代价：**该 daemon 不会开机自启/崩溃自拉起**，需要手动或重新
   安装服务（见第 8 节回滚/恢复）。另外 `--pair` 会轮换 device token，旧服务即便恢复
   也需要新的 repair code。
6. **`kb search` 在会话里被高频调用**：合规助手一轮里调了 4 次、整个联调期间 16 次，
   每次都真实打上游。后续若接入更大知识库，需要考虑限流或结果缓存。
7. **未上游化**：改动只在本地工作树，未 commit、未 push、未提 PR。

## 8. 回滚

按影响面从小到大：

```bash
# (a) 只关掉工具（保留代码）：清空 .env 里的 WEKNORA_* 或删掉整段，重启服务
cd ~/dev/cumora && python3 - <<'PY'   # 删除 .env 中的 WeKnora 段
import pathlib
p = pathlib.Path('.env'); t = p.read_text()
p.write_text(t.split('# ─── WeKnora retrieval')[0].rstrip() + '\n')
PY
# 然后重启 server；kb search 会以 "未配置" 拒绝

# (b) 回滚代码（本地工作树）
cd ~/dev/cumora && git checkout -- server/src/agents/cli.ts server/src/env.ts \
  && rm server/src/agents/weknora.ts server/src/__tests__/agents-weknora.test.ts

# (c) 恢复原来的 daemon（published 0.18.3，supervised）
#     注意：repair/pair 会轮换 device token，恢复前需要新的配对码
cp ~/.cumora/rollback/io.cumora.daemon.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/io.cumora.daemon.plist
#     若旧 token 已失效，daemon 会提示重新配对：
#     npx cumora@latest agent computer --pair <new-code> --server http://localhost:5181 --install-service

# (d) 撤销 WeKnora 侧授权：吊销 scoped key
curl -X DELETE http://localhost:8180/api/v1/tenants/10000/api-keys/<key_id> \
  -H "Authorization: Bearer <owner JWT>"
```

数据面无需回滚：工具只读，未写入任何知识库内容。

## 9. 下一步

1. 让 agent 独立把 Ship 契约里的三个验证方块标为 passed（`cumora ship square
   <feature> <square> passed --evidence "…"`）——builder 不能自证，这是刻意设计。
2. 决定是否评估 `kb ask`（WeKnora RAG 成稿 + 引用）以及是否需要相关性阈值。
3. 决定是否把本轮改动上游化（含 `slugifyAgentName` 的 friction 修复）。

工作入口：Cumora 的 Ship 契约
`ship-7d2d608a-d309-4697-b643-32e9ca8c337f`（状态 `verifying`，3 条不变式、3 个
待 agent 独立验证的方块、1 条 friction）。
