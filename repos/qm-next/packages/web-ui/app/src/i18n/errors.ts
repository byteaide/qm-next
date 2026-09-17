import { currentLocale } from "./index";

/**
 * Machine error code → zh display text.
 *
 * The English display for a coded API error is the server's own English
 * `message` (or the code itself), so no en table exists — en resolves to the
 * raw ApiError message. Keys mirror the `error` field emitted by the api
 * routes (packages/api/src/routes/*), the credential broker
 * (packages/api/src/credential-broker.ts), the web-ui thin server
 * (packages/web-ui/src/server.ts), and the portal
 * (packages/portal/src/portal-routes.ts).
 */
export const errorZh: Record<string, string> = {  // Generic envelope codes (the ~87% bucket; specific parameter details from
  // the server stay on console.debug).
  bad_request: "请求无效",
  not_found: "资源不存在",
  forbidden: "没有权限执行该操作",
  unauthorized: "登录状态已失效,请重新登录",
  conflict: "内容已被修改,请刷新后重试",
  gone: "链接已失效",
  unavailable: "服务暂不可用,请稍后重试",
  upstream_error: "上游服务出错,请稍后重试",
  upstream_unreachable: "无法连接上游服务",
  unreachable: "无法连接目标服务",
  payload_too_large: "内容超出大小限制",
  rate_limited: "请求太频繁,请稍后重试",
  not_supported: "暂不支持该操作",
  not_configured: "该功能未在当前部署启用",
  missing: "缺少必要参数",
  exists: "同名内容已存在",
  bad_core_response: "核心服务响应异常",

  // Apps / deployments
  deploy_failed: "部署失败",
  rollback_failed: "回滚失败",
  archive_failed: "归档失败",
  restore_failed: "恢复失败",
  rename_failed: "重命名失败",
  display_name_failed: "显示名称保存失败",
  invalid_deployment_layer: "部署层级无效",
  capability_required: "需要 Agent 能力令牌",
  harness_not_approved: "该执行器未获批准",
  not_a_playground: "该文件不是可运行的应用",

  // Webhooks
  webhook_create_failed: "Webhook 创建失败",
  invalid_filters: "过滤器配置无效",
  invalid_destination: "推送目标无效",
  unsupported_verification: "不支持的验证方式",
  action_required: "缺少 action(Agent 指令)",

  // Conversations / channels
  forbidden_thread: "该会话只能在其原始上下文中继续",
  channel_in_use: "频道正被占用",
  invalid_channel: "频道无效",
  recipient_not_found: "找不到接收者",
  no_conversation: "没有可用会话",
  seed_turn_refused: "会话首条消息被拒绝",
  owner_mediation_required: "需要所有者处理",

  // Reach (packages/reach/src/contract.ts, relayed by reach-routes)
  not_a_member: "你不在该频道或群组中,无法发送",
  ambiguous_recipient: "该名称匹配到多个联系人,请指定确切的名称或 ID",
  channel_not_found: "找不到匹配的频道",
  ambiguous_channel: "该名称匹配到多个频道,请指定确切的名称或 ID",
  group_too_large: "群组人数超限,请改用频道",
  group_not_found: "找不到符合条件的群组",
  group_open_failed: "群组创建失败,请稍后重试",

  // Connectors / OAuth / keychain
  oauth_denied: "授权被拒绝",
  oauth_start_failed: "无法发起登录",
  oauth_poll_failed: "登录状态查询失败",
  oauth_complete_failed: "登录未完成",
  oauth_callback_failed: "登录回调校验失败",
  invalid_slack_installation: "Slack 安装配置无效",
  identity_unverified: "身份未验证",
  keychain: "密钥操作失败",
  revoke_failed: "撤销失败",
  grant_failed: "授权失败",
  attach_failed: "附加失败",
  hash_mismatch: "文件校验不一致,请重试",
  not_entitled: "当前会话未获该凭证授权",
  credential_unavailable: "凭证不存在或已停用",
  bad_url: "URL 无效",
  scheme_not_allowed: "仅允许 https 目标",
  host_not_allowed: "目标主机不在凭证允许列表内",
  method_not_allowed: "该 HTTP 方法不被允许",
  path_not_allowed: "路径不在凭证允许范围内",

  // Model / effort
  model_not_supported: "不支持该模型",
  model_not_enabled: "该模型未启用",
  effort_not_supported: "该模型不支持当前推理力度",
  fast_mode_invalid: "快速模式配置无效",

  // Skills / packs / soul
  pack_resolve_failed: "技能包解析失败",
  pack_fetch_failed: "技能包获取失败",
  pack_collision: "技能包命名冲突",
  soul_update_denied: "人格设定更新被拒绝",
  soul_update_failed: "人格设定更新失败",
  share_failed: "分享失败",

  // Environments
  environment_not_found: "找不到该环境",
  environment_create_failed: "环境创建失败",
  environment_attach_failed: "环境挂载失败",

  // Surface cache / IM
  surface_error: "视图数据加载失败",
  surface_timeout: "视图数据加载超时",

  // Portal session envelope
  sign_in: "请先登录",
  signed_out: "已退出登录",

  // Misc
  invalid_name: "名称无效",
  invalid_member: "成员无效",
};

export function hasZhError(code: string): boolean {
  return Object.hasOwn(errorZh, code);
}

/**
 * Locale-aware lookup for a coded API error. Undefined for the en locale
 * (the raw English message displays) and for unknown codes (same fallback).
 */
export function localizedError(code: string): string | undefined {
  if (currentLocale() !== "zh" || !hasZhError(code)) return undefined;
  return errorZh[code];
}

// Turn failures (pi-harness formatPiAssistantError) and send failures reach
// the UI as free text, not coded envelopes. Fixed harness templates and the
// common provider `error.type` values get zh labels; everything else passes
// through untouched.
const providerTypeErrorZh: ReadonlyArray<readonly [RegExp, string]> = [
  [/quota|insufficient/i, "模型额度不足"],
  [/rate.?limit/i, "触发模型服务限流,请稍后重试"],
  [/content.?filter|content.?policy/i, "内容被模型安全策略拦截"],
  [/overload/i, "模型服务过载,请稍后重试"],
  [/authentication|invalid_api_key|api.?key/i, "模型服务认证失败,请检查模型接入配置"],
  [/permission/i, "模型服务拒绝访问(权限不足)"],
  [/invalid_request/i, "模型服务拒绝了该请求"],
  [/timed?.?out/i, "模型服务响应超时"],
  [/^api_error$|internal/i, "模型服务内部错误,请稍后重试"],
];

const PROVIDER_ERROR_RE = /^Model provider API error(?: \((.+?)\))?: ([\s\S]*)$/;

/**
 * Localizes runtime error text shown in the timeline at render time: turn
 * failures (`errorMessage`) and send failures (`sendFailure`). Unknown text
 * passes through unchanged; the raw English always lands on console.debug
 * when a zh label replaces it.
 */
export function localizeTurnError(raw: string): string {
  if (currentLocale() !== "zh" || !raw) return raw;
  if (raw === "Pi agent stopped with an error") return "助手运行出错,已停止。";
  if (raw === "Message wasn’t sent. Check your connection and try again.") {
    return "消息未发出,请检查网络连接后重试。";
  }
  const m = PROVIDER_ERROR_RE.exec(raw);
  if (!m) return raw;
  const type = m[1] ?? "";
  const detail = m[2] ?? "";
  const label = providerTypeErrorZh.find(([re]) => re.test(type))?.[1];
  if (!label) return raw;
  console.debug("web-ui: provider error detail", raw);
  return detail ? `${label}:${detail}` : label;
}
