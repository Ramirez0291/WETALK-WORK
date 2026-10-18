# dev-lib

工坊（暂名 `WETALK-WORK`）的设计文档与开发文档。这里是 2026-10-18 从 Claude Docs 导出的快照；线上版本是最新版，线上更新后需要重新导出。

| 文件 | 内容 | 版本 |
| --- | --- | --- |
| `workbench-design-v2.md` / `.pdf` | claudework 多 Agent 工坊设计：设计原则、三种工作方式、调度与提交、记忆与任务包、证据与分歧、PPT 生产流程、模型分工、试运行路线图 | V2 |
| `workbench-dev-spec-v0.2.md` / `.pdf` | WETALK 工坊开发文档：数据模型、四份核心契约、工作包 WP1–WP7、接口、配置、测试、待定事项 | v0.2 |
| `images/workbench-structure.png` | 设计文档中的结构图 | — |

阅读顺序：先读设计文档了解“为什么”，再读开发文档了解“怎么做”。实现时以开发文档的四份契约为准；两份文档有出入时，以开发文档为准。

Markdown 版里的人员提及和文档互链已转为纯文本；完整排版请看 PDF。

线上版本：

- 设计 V2：https://claude.ai/code/artifact/110bcbe5-3e95-4233-994e-ba9902373d50
- 开发文档：https://claude.ai/code/artifact/50111a67-fcf4-4d8a-9fb9-01951b22c74b

## 开发日志

`astra-log/` 下是主程（Claude）每个工作包完成后留给评审（Astra）的日志，文件名为 `WP<编号>-<日期>.md`。
