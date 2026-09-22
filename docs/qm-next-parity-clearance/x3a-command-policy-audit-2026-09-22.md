# X3a — command-policy 引擎差距审计（2026-09-22）

只读审计。对象：qm `src/policy/command-policy.ts`（911 行）vs qm-next 现有两侧实现（`@qm/sandbox` Phase 3J 正则引擎 + `@qm/security` CommandGate 类目引擎）。产出：差距矩阵 + X3b（simulate 501）解锁路径。

## 结论（先读这段）

1. qm-next 有**两套**策略引擎、**零个**生产调用方。`@qm/sandbox/policy.ts`（正则规则引擎，类型与 qm 同构）和 `@qm/security` CommandGate（类目 + 注册表 + 审批回路）并存；但生产沙箱未配置 policy（`api/service.ts:851` 不传 `policy`），`gate.evaluate` 无任何生产调用——两套引擎都处于**休眠**状态。
2. qm 的核心资产是 `scannableCommand`（约 600 行 shell 语义归一化器：引号/ANSI-C/heredoc/子 shell/包装命令/管道注入/SQL 负载提取，深度 8 递归），qm-next 明确没有等价物（sandbox 引擎自述"只匹配字面量，不解析 shell 语法"）。这是最大的语义差距。
3. **X3b 不被 scannableCommand 移植阻塞**。simulate 的保真度 = 生产保真度：生产引擎现在是字面量匹配，simulate 用同一个求值器即是一致的。X3b 真正的前置是：(a) 引擎被唤醒（接线），(b) 策略来源可解析（内联 policy 已支持 + org 基线）。全量收敛（存储/分层/CRUD）可后置。
4. qm 有 689 行测试语料（`test/command-policy.test.ts` 506 行 + `command-policy-route.test.ts` 183 行）可直接改造复用为移植验证——大幅降低 scannableCommand 移植风险。

## 架构对照

| 维度 | qm | qm-next @qm/sandbox（Phase 3J） | qm-next @qm/security（CommandGate） |
|---|---|---|---|
| 规则模型 | `{pattern: 正则, decision, reason}`，忽略大小写，`compileSafeRegex` 防 ReDoS | 同型 `CommandRule`（decision 已统一 `CommandDecisionValue`）；`new RegExp(pattern)` 无 `i` 标志、无 safe-regex | 无正则——按 9 个 `CommandClass`（shell/file_write/publish/…/sensitive_read）+ 可插拔策略对象（baseline-deny、allowlist） |
| shell 语义 | `scannableCommand`：引号/`$''`/heredoc（保留喂给解释器的）/`$()`/反引号/`sh -c`/`eval`/`env -S`/`sudo|nice|timeout|time|nohup|stdbuf|xargs|coproc` 包装、echo/printf 管入 shell 与 SQL 客户端、herestring、简单变量负载；深度 8 递归 | 无——字面量匹配（文件头显式声明，`rm -rf /tmp/foo` 不匹配 `rm -rf /` 是"有意为之"） | 无文本概念——argv/fields 结构化 |
| 分层 | org 基线 `composePolicy(org, scope)`（org 规则在前、allowlist 模式以 org 为准）+ 部署层 commandRules + ephemeral_only deny 规则（credential_exec 切流强制）前置 | 单策略，无组合 | 单激活策略（`setActive`），无 org/scope 层 |
| 存储 | 每作用域持久化 `commandPolicyStore`，org 播种 `defaultOrgPolicy()` | 无 | 无（策略是代码构造） |
| 默认规则 | `ORG_FLOOR_RULES` 5 条（递归 rm、force push、破坏性 SQL、mkfs/fork-bomb→deny、管道入 shell） | `default-policy.ts` 灾难级专用（rm 根路径、mkfs、dd、fork bomb、chown/chmod -R /、DROP/TRUNCATE），语义更窄 | 类目级：所有 side-effecting + sensitive_read → `require_approval`（更保守，无模式智能） |
| 执行点 | exec / backgroundStart（`tools/primitives.ts:573,931`）+ credentialExec（`orchestrator.ts:1887`）→ `CommandDenied`/`NeedsApproval` | `LocalSandbox.run` docker exec 前置检查（deny→伪造 stderr ExecResult；require_approval 放行给 harness）——**但生产未配置，休眠** | 端口 + 注册表 + 指标（`bumpCommandGateDecision`）；**无生产调用方** |
| 审批 | `authorizeCommand(command, approvalKey)` 按 rule.pattern 键的 session/always 授权 | NeedsApproval 异常放行给 harness | 审批回路已建成（durable ApprovalRequest + `suspendForApproval` + 按 `commandRequestId` 恢复，比 qm 的 pattern 键更强）——但无策略产生 require_approval |
| 管理面 | command-policy CRUD 资源（`admin-resources.ts:206`）+ simulate（`admin/scope-config.ts:49-78`：同运行时组合 → 求值 → decision/matched/ruleSource/ruleIndex → 审计） | 无 CRUD；simulate 501（`admin-routes.ts:238-244`） | 无 |

## 差距矩阵

| # | 差距 | 严重度 | 说明 |
|---|---|---|---|
| G1 | scannableCommand 语义归一化缺失 | 高 | 约 600 行纯函数，qm 测试语料可复用；绕过手法（`sh -c` 包装、管道注入、SQL `-c`、变量间接）在字面量匹配下全部穿透 |
| G2 | 双引擎均无生产接线 | 高 | `api/service.ts:851` 未传 `policy`；`gate.evaluate` 无调用方。安全不变量（ADR-0002）目前只是纸面 |
| G3 | 分层缺失（org 基线 + scope + 部署层 + ephemeral_only） | 中 | `composePolicy` 本体 8 行；前置条件是 G4 存储存在 |
| G4 | 每作用域策略存储 + CRUD 缺失 | 中 | qm-next 无 config-store 等价物承接 policy；simulate 的"读存储策略"分支依赖它 |
| G5 | X3b simulate 未实现 | 中 | 见解锁路径；inline-policy 版本可先行 |
| G6 | 双引擎收敛方向未决 | 中 | 建议：规则引擎作为 CommandGate 的一种 `CommandPolicy` 实现（文本取自 `args.argv`/`rawText` → scannableCommand → firstMatch），类目策略管结构化操作（publish/webhook/mcp 是 qm 用其他机制管的，qm-next 类目设计是超集） |
| G7 | 沙箱引擎无 `i` 标志 + 无 safe-regex | 低 | qm 全部忽略大小写 + ReDoS 防护；qm-next 运营者可提交规则 = ReDoS 面。小修，应随任意移植顺带。（2026-09-22 已修：`compileSafeRegex` 移植 + `i` 标志 + `(?:` 语法修复——qm 分析器把 `(?:` 的 `?` 误判为量词并把组内原子量词错误记到整个组，qm 规则碰巧全避开；qm-next 的 mkfs 规则改写为两条避开 `(?:...)?` 形式） |
| G8 | require_approval → ApprovalRequest 链路断开 | 低 | 审批回路强（commandRequestId），缺"策略产出 → NeedsApproval → 挂起"一跳；G2 接线时补 |

## X3b（simulate）解锁路径

qm 参照实现：`admin/scope-config.ts:49-78`——inline policy（`parseCommandPolicy` 校验）或存储策略 → org 组合 → `evaluateCommand` → decision/matched/ruleSource/ruleIndex → 审计 `command-policy.simulate`。

- **最小版（~0.25 天，可进第 3 批）**：先做 G7（`i` 标志 + safe-regex）+ G2-lite（api 装配线给沙箱配 `'default-denylist'`，唤醒引擎）→ simulate 接受 inline policy + org 基线，求值器与生产共用同一个 `evaluateCommandPolicy`。一致性即保真。（2026-09-22：已实现，含 6 条引擎测试 + 6 条路由测试）
- **完整版（第 4 批，~1-1.5 天）**：G1（scannableCommand 移植 + qm 语料回归）→ 生产与 simulate 同步升级语义；G4（存储 + CRUD）→ simulate 的存储分支与 ruleSource/ruleIndex 归属；G3（composePolicy）→ 组合语义对齐。
- 收敛方向（G6）需要一个决策记录：规则引擎收编为 CommandGate 的策略实现，`PolicyVerdict` 已是 `CommandDecision` 同形（KV-005 切换完成），合并成本主要在请求形状适配。

## 工作量估算

| 项 | 估算 |
|---|---|
| G7 + G2-lite 唤醒引擎 | ~0.5 天（第 3 批候选） |
| X3b 最小版 | ~0.25 天（第 3 批候选） |
| G1 scannableCommand + 语料回归 | ~1-1.5 天（第 4 批） |
| G4 存储 + CRUD + G3 分层 | ~0.5-1 天（第 4 批） |
| G6 收敛 + G8 审批链接 | ~0.5 天（随第 4 批） |

## 证据索引

- qm：`src/policy/command-policy.ts`（911 行全文）；`tools/primitives.ts:573,931`；`core/orchestrator.ts:1355,1887`；`resolution/resolution-service.ts:70-72`；`resolution/config-store.ts:290,361,610-615`；`api/routes/admin/scope-config.ts:49-78`；`api/routes/admin-resources.ts:206-216`；`test/command-policy.test.ts`（506 行）、`test/command-policy-route.test.ts`（183 行）
- qm-next：`packages/sandbox/src/policy.ts`（字面量匹配自述）、`default-policy.ts`、`local-sandbox.ts:52-59,108-131,464-473`；`packages/types/src/tools.ts:32-40`（CommandRule/CommandPolicy）、`types/src/command-gate.ts`；`packages/security/src/command-gate.ts`、`command-policy.ts`、`command-policy-config.ts`、`policies/{allowlist,default-denylist}.ts`；`packages/api/src/routes/admin-routes.ts:238-244`（501）、`api/src/service.ts:851`（未配 policy）；`packages/runs/src/approval-continuation.ts`（审批回路）
