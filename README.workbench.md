# WETALK 工坊（WETALK-WORK）

从 [WeTalk](https://github.com/Ramirez0291/wetalk) 派生的多 Agent 内容生产工坊。WeTalk 本身保持轻便，工坊功能只在这个仓库里开发；WeTalk 设为 `upstream` 远程，按需同步修复：

```bash
git fetch upstream
```

设计与开发文档在 `dev-lib/`：先读 `workbench-design-v2.md`（为什么），再读 `workbench-dev-spec-v0.2.md`（怎么做）。两者有出入时以开发文档为准。

## 运行

```bash
npm start
```

- 本地配置 `wetalk.config.json` 默认用 7790 端口，可以和 WeTalk（7788）同时运行。
- 项目资料目录默认是本仓库下的 `projects/`（`workbench.defaults.json` 的 `projectsDir`，或环境变量 `WETALK_PROJECTS`）。它是一个独立的 git 仓库，本仓库忽略它；服务启动时如果它还不是 git 仓库会自动初始化。
- 服务进程是 `projects/` 里正式记录的唯一写入者。

## 工坊页面

服务启动后打开 `http://localhost:7790/`（工坊是主页面；研讨室在 `/talk`，旧地址 `/workbench` 仍可用）：

- **概况**：各类记录数、论断核验分布、待更新（stale）、有阻塞、可进入成品、待晋升候选稿、待留档提交、待你决定。
- **记录**：每条记录的派生状态（新鲜度、核验状态、阻塞、可进入成品）、上下游、历史版本和内容来源（provenance）。
- **追溯**：输入页面、论断或来源编号，看页面 → 论断 → 来源 → 原文位置；按论断引用时的来源版本核对引文。
- **提交与留档**：每次提交分开显示“数据已提交”和“留档已完成 / 待重试 / 失败”。
- **候选稿**：以主持人身份提交改动（先存为候选稿，再点“晋升”）。
- **待你决定**：服务进程之外改过的记录文件、读不出的记录文件、git 留档失败。

## 提交与恢复（契约二）

- 正式记录只经提交入口写入：`POST /api/projects/:p/submissions` 收稿为候选稿，`POST /api/projects/:p/submissions/:sid/promote` 在仓库级串行队列里晋升。
- 没有任务号的提交只接受工坊页面的主持人入口（页面里带有每次启动重新生成的令牌）；带任务号的提交在 WP4 的任务系统之前一律返回“任务不存在”。
- 事实来源是正式记录文件 ＋ `projects/commits.jsonl`。晋升先写 `_txn/<提交编号>/` 清单，再归档旧版本、逐个替换文件、追加 applied；启动时按清单补完未完成的提交。
- 启动时在 `projects/` 建 `.workbench.lock`，已有存活的服务（或正在本地新建项目的命令行工具）就拒绝启动。
- git 留档从 blob 取确切字节、用临时索引提交，只包含本次清单里的文件，不动工作区和你已暂存的改动；失败后每 60 秒重试，按提交编号顺序补交。
- 写入出错且就地重做也失败时，服务进入“写入故障”状态，拒绝一切写入，直到重启时把那次提交做完。
- 服务进程之外改过或删掉的记录文件不会被采纳：页面和追溯显示的仍是已提交的内容，它和下游标为待更新，涉及它的晋升被拒绝。
- **git 不是完整备份。** 提交日志、候选稿、旧版本副本和 blob 不进 git。备份或迁移项目时，要保留整个 `projects/` 目录。

## DeepSeek（WP3）

- 密钥只从环境变量 `DEEPSEEK_API_KEY` 读取，不写进任何配置文件。PowerShell 里：

  ```powershell
  $env:DEEPSEEK_API_KEY = (Get-Content .\DeepSeek-devAPIKEY.txt -Raw).Trim(); npm start
  ```

  开发用密钥文件已被 `.gitignore` 忽略，不要提交。
- 研讨室参与者：在 `wetalk.config.json` 里加 `{"id":"deepseek","name":"DeepSeek","adapter":"deepseek","model":"deepseek-flash","effort":"high"}`（`effort` 可选 none / low / high / max）。它走 API，没有命令行；有密钥就显示为可用，“停止”同样能中断。调用记录里有 `usage`（token 与按价目估算的美元）和每次尝试的状态。
- 重试：408、429、5xx 和网络错误按 `retry.delaysSec` 退避（有 `Retry-After` 时优先），其他 4xx 不重试。`deepseek.timeoutSec` 是整次调用（含重试）的总时限。
- 工坊接口：`POST /api/projects/:p/web/search`（只给线索，结果不能作为引文）、`POST /api/projects/:p/web/fetch`（`{url, source_id?, create?}`，正文存成来源快照）、`GET /api/projects/:p/usage`、`POST /api/projects/:p/sources/:id/availability`（主持人确认来源已不存在）。
- 用量账本 `projects/<项目>/usage.jsonl` 记每一次尝试（含失败与重试），项目的调用次数与费用上限（`budget`）按它累计；到上限后新调用和重试都被拒绝。费用要等返回才知道，最后一次调用可能略超费用上限。
- 价目在 `workbench.defaults.json` 的 `pricing`（高峰价，低谷按 `offPeakFactor` 折算；不识别中国节假日，一律按高峰估算，宁可高估）。价格变了改这里。
- 来源正文只有两个来处：Fetch 快照，或主持人在工坊页面手工录入。论断的引文必须能在所引来源版本的正文快照里找到（忽略 Markdown 的标点转义和空白重排），否则不能晋升。

## 任务（WP4）

- 工坊页面的“任务”标签：新建任务（类型来自 `modes`，另有 `anonymous_review`、`audience_reader`），派发给指定参与者，取消，处理“待你决定”，查看每次尝试的任务包，揭晓密封轮次。
- 状态：提出 → 可认领 → 进行中 → 已交稿 → 完成；另有失败（尝试次数用完）、已取消、待你决定（类型不允许、深度或预算超限）。租约默认 30 分钟，到期自动收回；迟到的旧结果存为历史草稿，不会覆盖新结果。
- 任务包存在 `projects/<项目>/archive/packets/`，记录当时实际发送的提示词、全部输入（按内容 hash）和有效配置，能完整还原。
- **可见性**：
  - Claude、Codex 和 DeepSeek 执行工坊任务时，输入一律写进提示词，不给任何工具。WP4 在本机实测过：只开读类工具的 Claude、开着 shell 的 Codex 都能读到工作目录以外的文件。
  - Codex 另外关掉内置应用、插件、浏览器、多 Agent、网络搜索等，并按 `--json` 事件审计：出现任何工具调用，那份稿子都标为“独立性未证明”。
  - 密封类任务（竞争起草、匿名评审、观众型读者）的结果在揭晓前只留在服务进程内存里；服务重启则本轮重跑。
- 命令行 Agent 的每次调用同样占项目的调用次数上限。
- MCP 新增工具：`wetalk_task_list`、`wetalk_task_claim`（返回租约凭证和任务包）、`wetalk_task_renew`、`wetalk_submit`、`wetalk_record_read`、`wetalk_trace`。外部会话的身份一律记为未证实；密封类任务不能由外部会话认领。`mcp.mjs` 默认连本仓库配置里的端口。
- 真实 Agent 的可见性实测脚本：`node tests/workbench/live/live-agents.mjs codex deepseek claude`（会真实调用，不在 `npm test` 里）。Codex CLI 升级后要重跑。

## 新建项目

```bash
npm run new-project 项目名
```

服务在运行时，脚本经由服务接口创建；连不上服务时先取项目目录的锁，取得到才在本地创建（取不到说明服务还活着，直接报错）。新项目包含 `project.md`（项目约定）、`protocol.json`（对默认参数的覆盖）、`baseline.md`（单 Agent 基线记录）和固定的子目录。模板在 `templates/project/`。

`projects/` 下没有 `project.md` 的目录（例如原始资料文件夹）不算项目，接口和列表都会忽略它们。

## 参数

可调参数的默认值在 `workbench.defaults.json`，项目用自己的 `protocol.json` 覆盖，只写要改的键。含义见开发文档“配置文件”一节。补充说明：

- `rounds: null` 表示沿用 WeTalk 现有的讨论与表决轮次设置。
- 以 `_` 开头的键是备注，合并时忽略。
- `modes` 和 `routing` 允许项目新增键；其他位置写了未知的键会报错，避免拼错的参数被悄悄忽略。
- 调用次数、API 费用、任务深度、尝试次数、补证次数、重试次数和租约时长是系统不变量：必须是有限的数字，不能删掉或设为无限。

## 运行依赖

目前没有 npm 运行依赖。需要本机已安装：

| 依赖 | 用途 |
| --- | --- |
| Node.js 18+ | 服务与测试 |
| git | `projects/` 的自动留档（不可用时数据照常提交，只是没有留档） |
| DeepSeek API | 对话、Search、Fetch（Node 自带 fetch，没有 npm 依赖）；需要环境变量 `DEEPSEEK_API_KEY` |

后续工作包引入的依赖（例如 PPT 导出用的 python-pptx）会在这里逐项写明用途。

## 测试

```bash
npm test
```

工坊模块的测试在 `tests/workbench/`，每个测试在临时目录（路径含中日文字符）里建样本项目。
