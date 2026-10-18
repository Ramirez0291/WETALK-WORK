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

## 新建项目

```bash
npm run new-project 项目名
```

服务在运行时，脚本经由服务接口创建；服务没运行时才直接写本地。新项目包含 `project.md`（项目约定）、`protocol.json`（对默认参数的覆盖）、`baseline.md`（单 Agent 基线记录）和固定的子目录。模板在 `templates/project/`。

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

后续工作包引入的依赖（例如 PPT 导出用的 python-pptx）会在这里逐项写明用途。

## 测试

```bash
npm test
```

工坊模块的测试在 `tests/workbench/`，每个测试在临时目录（路径含中日文字符）里建样本项目。
