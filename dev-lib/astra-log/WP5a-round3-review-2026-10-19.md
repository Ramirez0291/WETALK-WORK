# WP5a 第三轮 Review · Astra → Claude Opus

- 日期：2026-10-19（Asia/Tokyo）。
- 评审对象：`4bd0008`（第二轮修复）、`7b7371a`（文档同步，当前 HEAD）。
- 依据：设计 V2、本地开发文档 v0.2、前两轮评审、`WP5a-fix2-2026-10-19.md` 与提交差异。
- **结论：本轮复审通过，第二轮 R1、R2 关闭；未发现需要阻塞 WP5a 的新增问题，可以继续 WP5b。**
- 范围仍按主持人批准的 WP5a/WP5b 拆分；本结论不包含尚未交付的竞争、移植补丁与研讨室整合，也不代表真实模型或浏览器交互验收。

## 第二轮问题核销

| 问题 | 结果与依据 |
| --- | --- |
| R1 · P1 · 同一参与者换厂商后丢失后续作者身份 | **关闭。** `authorKey` 按主体类型＋参与者＋厂商去重，`mergeAuthors` 保留两次贡献；提交时并入上一版 provenance，`authorsOf` 同时并入当前 provenance。原独立探针实际得到 writer/deepseek 与 writer/openai 两项，Codex 核验因 `same_vendor` 被拒，`ready=false`。新增正式回归覆盖两个厂商的核验与派发拒绝、OpenAI 裁定拒绝、第三厂商核验通过，以及 unknown 历史保留。 |
| R2 · P2 · authors 进入匿名评审提示词 | **关闭。** `contentOf` 在记录输入序列化时剔除 `provenance`、`authors`、`verifier`、`raised_by`、`commit`、`updated_at`。原独立探针中匿名任务正常 submitted，最终提示词的 `containsHumanName`、`containsAuthorsField`、`containsHumanKind` 均为 false。新增正式回归覆盖主持人、已移出配置的作者、多位作者、模型信息，以及补证输入。 |

补充检查：对两个换厂商方向和重复贡献进行了纯函数断言；过时或缺失 authors 时当前 provenance 仍参与资格判断，system 不作为作者，unknown 历史继续阻止 Agent 独立核验。逐项验证六个生产者/系统字段被剔除，来源卡的文献 `author`、内容和版本字段保留，原记录对象没有被修改。服务端正式记录与归档仍保存身份。

本轮文档的两项修订与实现一致。按厂商累计是已批准的保守规则，不要求在此实现实质改写后的作者解绑。

## 第一轮问题回归

重跑 `WP5a-rereview-probes-2026-10-19.mjs`，观察结果均符合修复后的预期：

- 人工小改后原作者核验被 `is_author` 拒绝。
- unknown 厂商裁定被 `judge_vendor_unknown` 拒绝，异议保持 open。
- 已报告厂商与作者相同时，核验晋升被拒，无核验记录，论断不能进入成品。
- 补证任务仍指向 C001@1，并附 S001@1 正文，未替换为新版来源。
- 撤销 gone 后，规则提出的 needs_user 异议变为 withdrawn。
- V1000 的 unsupported 覆盖 V999 的 supported，旧记录标为 superseded。
- resolve 接口原样同号重试未报冲突；正式回归另核对相同 sid/cid、不增版及不同内容仍冲突。

该脚本部分场景打印观察值，退出码 0 本身不代表全部产品行为通过；上面的核销依据包含逐项输出检查及正式测试。

## 测试结果与环境说明

实际执行了完整 `npm test`、上轮独立探针、补充纯函数断言，以及针对清理异常的单文件重跑。

1. 默认沙箱临时目录中的项目创建遇到 rename `EPERM`。将当前进程的 TEMP/TMP 指向项目内专用 `.review-tmp-wp5a` 后，项目创建和独立探针通过。
2. 沙箱仍禁止连接测试使用的本机 HTTP 服务，单独复核得到 `connect EACCES 127.0.0.1`；这次受限运行不能用作产品回归结论。
3. 获准在沙箱外运行完整回归：**168 项功能测试全部通过**；`review-wp4.test.mjs` 的 after hook 清理临时目录时发生一次 `EPERM`，测试器额外记为文件级失败，所以实际汇总为 **169 项、168 通过、1 失败，退出码 1**。不能将这次命令记成一次全绿的 `npm test`。
4. 随后在相同代码下单独重跑 `node --test tests/workbench/review-wp4.test.mjs`：**16/16 通过，0 失败，退出码 0**，清理 hook 也成功。该异常未在这次重跑复现，不据此认定为本次修复引入的业务缺陷。
5. 独立复审探针退出码 0；补充纯函数断言通过；`git diff --check 4bd0008^ 4bd0008 -- lib tests` 通过。

测试使用临时项目、假 Agent 和本机模拟服务；没有调用真实收费模型，没有进行浏览器交互验收。TEMP/TMP 只对测试命令进程生效，没有改系统环境变量或项目配置。

## 交接

本轮只新增此评审日志。业务代码、正式测试、开发契约、真实项目、配置、密钥及工作区原有 LICENSE 修改均未改动；没有提交或推送。测试结束后清理本轮项目内专用临时目录。

Claude 可按既定范围继续 WP5b；下次交接请注明实现提交、文档变更和测试结果。
