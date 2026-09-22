# T5 评估：ToolContext publish + createPlayground（2026-09-22）

**任务**：对齐规划（`qm-next-alignment-plan-2026-09-22.md` §2 T5）要求先评估 portal/blobs 集成面与 sandbox 产物物化路径，再决定移植或维持诚实不可用。
**方法**：逐行核对 qm 参考实现（`src/tools/primitives.ts:768-871` publish、`:681-690` createPlayground、`src/playgrounds/playground.ts` 全 49 行、`src/harness/pi-tools.ts:950-971` 工具描述）与 qm-next 底座（`@qm/deploy-runtime`、`DeployGitStore`、`@qm/api` file-store/grant-ledger、files 路由族）。

## 结论

| 桩 | 判定 | 依据 |
|---|---|---|
| `createPlayground` | **可小移植**（建议列第 3 批，与 Q2 同批） | 不走 sandbox；qm-next 文件存储/路由已在；唯一真实缺口是"产物自动附接回合"的投递路径 |
| `publish` | **维持诚实不可用 → 登记有意偏差** | 三项依赖缺口，其中公网 URL 面与 2026-09-22 拍板的 Fly/AWS 暂缓直接绑定 |

## createPlayground：小移植可行

qm 原语（`primitives.ts:681-690` + `playground.ts`）完全**不触 sandbox**：HTML 直写工件库（≤512KB 校验、标题规整 ≤80 字符、`mimetype: text/html`、`direction: out`），返回 `{kind:'playground', artifactId, title}`；投递靠"turn attachment 自动附接"（`pi-tools.ts:952`：*The playground is attached to the turn automatically, so do not add a marker or URL to the reply*）。

qm-next 底座对照：

- 写入：`FileStoreService.uploadForViewer(principalId, {scopeId, name, mimetype, bytes})` 可直接承载（`api/src/services/file-store.ts:41-44`）；memory/PG 双实现齐备。
- 校验/规整：49 行纯函数，字节级可移植。
- 展示：files 路由族已有 inline content 下载（`tranche14`/`files` 测试覆盖）。

**唯一缺口**：turn-attachment 投递——产物自动附到当前回合的消息面（qm 走附件通道）。需在 im-bridge 的投递路径上接一个 attachment hook。工作量：存储侧 ≤0.5 天；投递侧 0.5-1 天（视 im-bridge 现有 attach 面）。

## publish：三项依赖缺口，随 Fly/AWS 一并移植

qm 的 publish（`primitives.ts:768-871`，约 100 行编排）需要：

1. **sandbox→DeployFile[] 收集器**：`collectTree` 遍历工作区产物。qm-next 的 ToolContext 有 read/list 原语，机械移植，非阻塞。
2. **resident-auth 捕获**：`captureResidentAuth`（含 `actingSlackUserId`——Slack 词汇，`check:im` 中立化规则适用）。qm-next 无 sandbox `$HOME` 登录态捕获运行时；缺位时 publish 只能透传 env，属行为降级。
3. **公网 URL 面**：`publicWebUrl` + `/d/<ref>/` 对外可达端点。qm-next 的 `DeployEndpoint` 是 `{host, port}`（本地 Docker），无公网域名配置——publish 的用户价值（分享可访问的应用）无法成立。

**底座利好**：`@qm/deploy-runtime`（`DeployProvider` 端口 + Docker provider + 物化器）、`DeployGitStore`（版本化/bundle/diff）、部署 store（deploy/redeploy/rollback/archive/rename 路由已测）都是 MVP 就绪——Fly/AWS PRD 落地时，publish 移植主要是收集器 + audience 解析（`publish-audience.ts` 语义）+ URL 面，不需要重建部署运行时。

**判定**：登记有意偏差，触发条件 = Fly/AWS provider PRD（2026-09-22 用户拍板暂缓）。在此之前 `publish` 维持诚实不可用（`tool-context.ts:257`），不造假 URL。

## 移植顺序建议

1. 第 3 批：createPlayground（含 attachment 投递 hook）——独立于 Fly/AWS。
2. Fly/AWS PRD 批：publish（依赖 provider + publicWebUrl；届时补 resident-auth 的中立化设计决策）。
