/**
 * AI 顾问（视觉大模型兜底 + 模板自学习）的公共契约：主进程与渲染进程共用的类型、默认值、取值范围、平台预设、
 * 枚举与中文标签，以及纯函数（归一化 / 合并 / 打码视图 / 体检 / 洗凭据）。移植自原版 src/shared/ai.ts。
 *
 * ★ 默认值只有一份权威：`defaultAiConfig()`。主进程、设置页与离线测试一律用它，别处不许再写 20 / 1280 这类字面量。
 * ★ 取值范围只有一份：`AI_RANGE`（这里是边界不是默认值），设置页的 min / max 直接读它。
 * ★ 凭据纪律：渲染进程只拿得到 `AdvisorConfigView`（类型上就没有 apiKey）；任何往外送的文本先过 `scrubAiSecret()`。
 *
 * 本文件是纯模块：不引 Electron / node:* / sharp / OpenCV（test/shared-purity.test.ts 检查）。
 */

export const AI_HISTORY_LIMIT = 50;

// ── 配置 ──────────────────────────────────────────────────────────────────

export interface AdvisorConfig {
  /** 总开关。关掉后认不出界面时照旧只走 BACK 兜底，不发任何请求、不写任何记录。 */
  enabled: boolean;
  /** OpenAI 兼容接口根地址（填到 /v1 这一层，不带 /chat/completions）。 */
  baseUrl: string;
  /** ★ 凭据。只存本机 advisor.json（0600），绝不过 IPC、不进日志。 */
  apiKey: string;
  /** 模型名，必须支持图片输入。 */
  model: string;
  /** 单次请求超时（ms）。 */
  timeoutMs: number;
  /** 每小时最多问几次（所有实例合计）。0 = 不限制。识别出错时它是防止烧钱的熔断。 */
  maxCallsPerHour: number;
  /** 同一实例两次问询的最小间隔（秒）。点击前的复核（recheck）不受它拦截，但照样占额度。 */
  cooldownSeconds: number;
  /** 发给模型的截图宽度（像素），高度按比例；不超过截图本身的宽度。 */
  imageWidth: number;
  /** 模型自报置信度低于此值的建议不执行（确认动作另有 0.85 的下限）。 */
  minConfidence: number;
  /** 第二阶段：把模型给的区域放大再问一次，拿到更贴合的边界框（只对关闭 / 取消）。 */
  refine: boolean;
  /** 认出关闭按钮、点掉后回到已知界面时，自动把它裁成模板存进模板库。只在 autoActions 打开时生效。 */
  autoHarvest: boolean;
  /**
   * ★ 自动处理（DECISIONS A.3，默认关）：认不出界面时按风险评估执行白名单点击（关闭 / 取消，低风险确认要二次复核）。
   * 关着时仍按原版流程问询，只记录建议，交回原来的兜底阶梯，绝不点击设备。
   */
  autoActions: boolean;
}

/** ★ 唯一权威默认值（原版 defaultAiConfig + 本仓库的 autoActions 默认关）。 */
export function defaultAiConfig(): AdvisorConfig {
  return {
    enabled: false,
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: '',
    model: 'qwen3.8-flash',
    timeoutMs: 40_000,
    maxCallsPerHour: 20,
    cooldownSeconds: 20,
    imageWidth: 1280,
    minConfidence: 0.5,
    refine: true,
    autoHarvest: true,
    autoActions: false,
  };
}

/** 旧名字（本仓库原来的顾问用它）；与 `defaultAiConfig` 是同一个函数。 */
export const defaultAdvisorConfig = defaultAiConfig;

/** 取值范围（设置页表单的 min / max 与这里一一对应；这些是边界不是默认值）。 */
export const AI_RANGE = {
  timeoutMs: [5_000, 180_000],
  maxCallsPerHour: [0, 500],
  cooldownSeconds: [0, 3_600],
  imageWidth: [640, 2560],
  minConfidence: [0, 1],
} as const;

type RangeKey = keyof typeof AI_RANGE;

const BOOLEAN_KEYS = ['enabled', 'refine', 'autoHarvest', 'autoActions'] as const;
const STRING_KEYS = ['baseUrl', 'apiKey', 'model'] as const;
const NUMBER_KEYS = ['timeoutMs', 'maxCallsPerHour', 'cooldownSeconds', 'imageWidth', 'minConfidence'] as const satisfies readonly RangeKey[];
const CONFIG_KEYS: ReadonlySet<string> = new Set([...BOOLEAN_KEYS, ...STRING_KEYS, ...NUMBER_KEYS]);

function numberIn(value: unknown, fallback: number, range: readonly [number, number]): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(range[1], Math.max(range[0], n));
}

function text(value: unknown, fallback: string, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** 把磁盘 / 补丁上来的任意东西归一成合法配置：缺什么补默认值，越界的夹回范围，地址去掉尾部斜杠。 */
export function normalizeAiConfig(value: unknown): AdvisorConfig {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const d = defaultAiConfig();
  return {
    enabled: flag(raw['enabled'], d.enabled),
    baseUrl: text(raw['baseUrl'], d.baseUrl, 2048).replace(/\/+$/, ''),
    apiKey: text(raw['apiKey'], d.apiKey, 4096),
    model: text(raw['model'], d.model, 200),
    timeoutMs: Math.round(numberIn(raw['timeoutMs'], d.timeoutMs, AI_RANGE.timeoutMs)),
    maxCallsPerHour: Math.round(numberIn(raw['maxCallsPerHour'], d.maxCallsPerHour, AI_RANGE.maxCallsPerHour)),
    cooldownSeconds: Math.round(numberIn(raw['cooldownSeconds'], d.cooldownSeconds, AI_RANGE.cooldownSeconds)),
    imageWidth: Math.round(numberIn(raw['imageWidth'], d.imageWidth, AI_RANGE.imageWidth)),
    minConfidence: numberIn(raw['minConfidence'], d.minConfidence, AI_RANGE.minConfidence),
    refine: flag(raw['refine'], d.refine),
    autoHarvest: flag(raw['autoHarvest'], d.autoHarvest),
    autoActions: flag(raw['autoActions'], d.autoActions),
  };
}

/**
 * 本地体检：不发请求就能发现的问题（中文）。空数组 = 可以发请求。
 * 在原版基础上保留本仓库的加固：只接受 HTTPS（本机回环地址可用 HTTP），地址里不得带用户名、密码、查询参数或片段。
 */
export function aiConfigProblems(config: AdvisorConfig): string[] {
  const result: string[] = [];
  let url: URL | null = null;
  try { url = new URL(config.baseUrl); } catch { result.push('接口地址必须以 https:// 开头，例如 https://dashscope.aliyuncs.com/compatible-mode/v1'); }
  if (url) {
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) result.push('接口必须使用 HTTPS；本机模型可使用 HTTP localhost。');
    if (url.username || url.password || url.search || url.hash) result.push('接口地址不得包含用户名、密码、查询参数或片段。');
    if (/\/chat\/completions\/?$/i.test(url.pathname)) result.push('接口地址只填到 /v1 这一层，不要带 /chat/completions（助手会自己拼）。');
  }
  if (!config.model) result.push('模型名不能为空，例如 qwen3.8-flash。');
  if (!config.apiKey) result.push('还没有填 API Key。');
  return result;
}

/**
 * 保存补丁。apiKey 三态：不带这个键 → 保持原值；非空字符串 → 覆盖；空字符串 → 显式清空（「清除 Key」）。
 * 未知字段、类型不对直接拒绝（本仓库的加固）；配置不完整时不能打开总开关。
 */
export type AdvisorConfigPatch = Partial<AdvisorConfig>;

export function mergeAiConfig(current: AdvisorConfig, patch: AdvisorConfigPatch): AdvisorConfig {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('AI 顾问配置补丁无效');
  if (Object.keys(patch).some((key) => !CONFIG_KEYS.has(key))) throw new Error('AI 顾问配置包含未知字段');
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if ((BOOLEAN_KEYS as readonly string[]).includes(key) && typeof value !== 'boolean') throw new Error('AI 顾问开关无效');
    if ((STRING_KEYS as readonly string[]).includes(key) && typeof value !== 'string') throw new Error('AI 接口字段无效');
    if ((NUMBER_KEYS as readonly string[]).includes(key) && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error('AI 顾问限额参数无效');
    }
  }
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) merged[key] = value;
  const next = normalizeAiConfig(merged);
  const problems = aiConfigProblems(next);
  if (next.enabled && problems.length) throw new Error(`无法启用 AI 顾问：${problems.join(' ')}`);
  return next;
}

/** 打码：只留后 4 位（长度 ≤ 4 时整串盖掉），空串原样返回空串。 */
export function maskAiKey(key: string): string {
  const value = (key ?? '').trim();
  if (!value) return '';
  if (value.length <= 4) return '••••';
  return `••••••${value.slice(-4)}`;
}

/** 渲染进程看到的配置：类型上就没有 apiKey 这个键。 */
export interface AdvisorConfigView extends Omit<AdvisorConfig, 'apiKey'> {
  apiKeySet: boolean;
  /** 只留后 4 位，例如 ••••••ab12。 */
  apiKeyMasked: string;
}

/** ★ 主进程往渲染进程送配置的唯一出口。 */
export function toAiConfigView(config: AdvisorConfig): AdvisorConfigView {
  const { apiKey, ...rest } = config;
  return { ...rest, apiKeySet: apiKey.trim() !== '', apiKeyMasked: maskAiKey(apiKey) };
}

/** 可以安全写进日志的形状（apiKey 已打码）。 */
export function redactAiConfig(config: AdvisorConfig): Record<string, unknown> {
  return { ...config, apiKey: maskAiKey(config.apiKey) };
}

/** 把文本里的 apiKey 洗掉（本仓库更严：不设最短长度，只要设置了就洗）。 */
export function scrubAiSecret(value: string, config: Pick<AdvisorConfig, 'apiKey'>): string {
  const secret = (config.apiKey ?? '').trim();
  return secret ? value.split(secret).join('[已隐藏的凭据]') : value;
}

/** 设置页的预设（只是填表快捷方式，模型名以各家最新文档为准）。地址全是 HTTPS。 */
export const AI_PRESETS: ReadonlyArray<{ label: string; baseUrl: string; models: readonly string[] }> = [
  {
    label: '阿里云百炼（通义千问）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3.8-flash', 'qwen3-vl-plus', 'qwen3-vl-flash', 'qwen-vl-max'],
  },
  { label: '智谱 BigModel', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.5v', 'glm-4v-flash'] },
  { label: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k-vision-preview'] },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o'] },
];

// ── 建议（模型的输出）────────────────────────────────────────────────────

/**
 * 界面分类。原版万龙的 12 类（world_map / city / troop_panel / kicked …）与本仓库通用顾问的 gameplay / login 取并集：
 * 游戏档案决定提示词里给模型哪几类，记录里两套都能读回。
 */
export const AI_SCREEN_KINDS = [
  'world_map', 'city', 'troop_panel', 'gameplay', 'popup', 'dialog', 'kicked', 'login',
  'network', 'maintenance', 'update', 'loading', 'other', 'unknown',
] as const;
export type AdvisorScreen = (typeof AI_SCREEN_KINDS)[number];

export const AI_SCREEN_LABEL: Record<AdvisorScreen, string> = {
  world_map: '世界地图',
  city: '城内',
  troop_panel: '部队管理面板',
  gameplay: '游戏画面',
  popup: '活动弹窗',
  dialog: '系统对话框',
  kicked: '顶号/登录界面',
  login: '登录界面',
  network: '网络断开提示',
  maintenance: '维护/更新公告',
  update: '游戏资源更新',
  loading: '加载中',
  other: '其它二级页',
  unknown: '看不出来',
};

/**
 * 动作类型不直接代表风险。所有 tap 动作需要风险评估和目标框，由本地点击并复验；
 * back / none 不由 AI 执行 —— 交回原来的兜底阶梯（「BACK 之后必须取消退出框」这条安全逻辑只写一份）。
 */
export const AI_ACTIONS = ['tap_close', 'tap_cancel', 'tap_confirm', 'back', 'none'] as const;
export type AdvisorAction = (typeof AI_ACTIONS)[number];

export const AI_ACTION_LABEL: Record<AdvisorAction, string> = {
  tap_close: '点关闭按钮（×）',
  tap_cancel: '点「取消」',
  tap_confirm: '点确认/继续/重试',
  back: '按返回键',
  none: '不动',
};

export const AI_RISK_LEVELS = ['low', 'medium', 'high', 'unknown'] as const;
export type AdvisorRiskLevel = (typeof AI_RISK_LEVELS)[number];
export const AI_RISK_LABEL: Record<AdvisorRiskLevel, string> = {
  low: '低风险', medium: '中风险', high: '高风险', unknown: '风险不明',
};

export const AI_EFFECTS = [
  'dismiss', 'acknowledge', 'retry_connection', 'continue_loading', 'download_update', 'navigate',
  'purchase', 'spend_resource', 'delete', 'account_change', 'permission_change', 'send_message',
  'combat', 'exit_game', 'unknown',
] as const;
export type AdvisorEffect = (typeof AI_EFFECTS)[number];

export const AI_EFFECT_LABEL: Record<AdvisorEffect, string> = {
  dismiss: '关闭 / 取消',
  acknowledge: '确认信息',
  retry_connection: '重试连接',
  continue_loading: '继续加载',
  download_update: '下载游戏资源更新',
  navigate: '页面导航',
  purchase: '付费 / 购买',
  spend_resource: '消耗资源道具',
  delete: '删除 / 重置',
  account_change: '账号变更',
  permission_change: '权限 / 隐私变更',
  send_message: '发送消息',
  combat: '出征 / 战斗',
  exit_game: '退出游戏',
  unknown: '后果不明',
};

/** 本地闸门认可的低风险后果（原版 risk.ts LOW_EFFECTS）。 */
export const AI_LOW_EFFECTS: readonly AdvisorEffect[] = [
  'dismiss', 'acknowledge', 'retry_connection', 'continue_loading', 'download_update', 'navigate',
];

/** 设备像素或参考坐标下的矩形（见 `AdvisorAdvice.space`）。 */
export interface AdvisorBox { x: number; y: number; w: number; h: number }

export interface AdvisorRisk {
  level: AdvisorRiskLevel;
  effect: AdvisorEffect;
  buttonText: string;
  dialogText: string;
  consequence: string;
  reason: string;
  /** 可能产生的不利后果；无风险时明确返回空数组，缺失不视为无风险。 */
  hazards: string[];
}

export interface AdvisorAdvice {
  screen: AdvisorScreen;
  action: AdvisorAction;
  /** tap_* 必有，其余为 null。坐标空间见 `space`。 */
  target: AdvisorBox | null;
  /** 0~1。 */
  confidence: number;
  /** 模型给的一句中文理由（截到 200 字，已洗凭据）。 */
  reason: string;
  risk: AdvisorRisk;
  model: string;
  /**
   * 本地闸门的结论：no_action = back / none；blocked = 风险 / 置信度 / 目标没通过；
   * manual_review = 通过闸门（手动分析时由你决定是否操作；自动处理开着时可执行）。
   */
  review: 'no_action' | 'manual_review' | 'blocked';
  reviewReason: string;
  /** target 的坐标空间：frame = 截图像素（手动分析 / 模板候选），reference = 模板集参考画布（自动处理）。缺省 frame。 */
  space?: 'frame' | 'reference';
  /** 是否经过第二阶段放大精定位。 */
  refined?: boolean;
  /** 确认动作在点击前用新截图复核过。 */
  riskRechecked?: boolean;
  /** 问询（含精定位）耗时。 */
  latencyMs?: number;
}

/** 编辑器草稿用的元数据（手动分析的安全关闭建议）。编辑器必须重新截图并由用户核对后才保存。 */
export interface AdvisorTemplateProposal {
  gameId: string;
  index: number;
  sourceCapturedAt: number;
  frameWidth: number;
  frameHeight: number;
  box: AdvisorBox;
  suggestedName: string;
  sourceRecordId: string;
}

// ── 记录 / 状态 ───────────────────────────────────────────────────────────

export const AI_OUTCOMES = [
  'skipped', 'failed', 'unparsable', 'no_action', 'rejected', 'applied', 'verified', 'harvested',
  'advised', 'blocked', 'test_passed',
] as const;
export type AdvisorOutcome = (typeof AI_OUTCOMES)[number];

export const AI_OUTCOME_LABEL: Record<AdvisorOutcome, string> = {
  skipped: '未问询',
  failed: '请求失败',
  unparsable: '回复无法解析',
  no_action: '交回兜底',
  rejected: '建议被否决',
  applied: '已执行',
  verified: '已执行并回到已知界面',
  harvested: '已执行并裁出新模板',
  advised: '仅记录建议',
  blocked: '风险已拦截',
  test_passed: '测试通过',
};

/** 结果着色（渲染进程的语义色键）。 */
export const AI_OUTCOME_TONE: Record<AdvisorOutcome, 'neutral' | 'danger' | 'warning' | 'info' | 'success'> = {
  skipped: 'neutral',
  failed: 'danger',
  unparsable: 'warning',
  no_action: 'neutral',
  rejected: 'warning',
  applied: 'info',
  verified: 'success',
  harvested: 'success',
  advised: 'info',
  blocked: 'warning',
  test_passed: 'success',
};

/** 问询来源（哪条链路问的）。 */
export const AI_CONTEXT_LABEL: Readonly<Record<string, string>> = {
  'gather-g0': '采集流程',
  'scheduler-sample': '调度采样',
  'script-run': '脚本执行',
  manual: '手动分析',
  '用户手动查看当前画面': '手动分析',
  'vision-test': '视觉能力测试',
  test: '设置页测试',
};

export function aiContextLabel(context: string): string {
  return AI_CONTEXT_LABEL[context] ?? context;
}

export interface AdvisorRecord {
  id: string;
  at: number;
  /** 空串 = 与游戏无关（视觉能力测试）。 */
  gameId: string;
  /** 实例编号；null = 不针对实例（测试）。 */
  index: number | null;
  /** gather-g0 / scheduler-sample / script-run / manual / vision-test。 */
  context: string;
  outcome: AdvisorOutcome;
  /** 中文一句话，可直接显示。★ 已过 scrubAiSecret，≤500 字。 */
  message: string;
  advice: AdvisorAdvice | null;
  templateProposal: AdvisorTemplateProposal | null;
  /** 自学出的新模板 id（outcome = harvested 时）。 */
  harvestedTemplateId: string | null;
  /** 需要人处理（实例已暂停 / 这一步判失败，不再按 BACK 绕过）。 */
  requiresAttention?: boolean;
  /** 整个问询 + 执行的耗时。 */
  latencyMs: number;
  /** 真正发出的请求数（含失败的），计入每小时额度。 */
  providerCalls: number;
}

export interface AdvisorStatus {
  enabled: boolean;
  /** 地址 / 模型 / Key 都齐了（体检无问题）。 */
  configured: boolean;
  model: string;
  baseUrl: string;
  callsLastHour: number;
  /** 0 = 不限。 */
  maxCallsPerHour: number;
  /** 真正发出过请求的问询次数（不含测试）。 */
  consultCount: number;
  /** 历史里 outcome = harvested 的记录数。 */
  harvestedCount: number;
  autoActions: boolean;
  autoHarvest: boolean;
  refine: boolean;
  lastRecord: AdvisorRecord | null;
  /** 读配置文件时的问题（例如文件损坏已改名留证、从默认值重建）；null = 没有。 */
  loadWarning: string | null;
}

// ── 测试 / 失败分类 ──────────────────────────────────────────────────────

export type AdvisorFailureKind =
  | 'config' | 'auth' | 'model' | 'vision' | 'rate' | 'bad_request' | 'network' | 'timeout' | 'server' | 'bad_response';

export const AI_FAILURE_LABEL: Record<AdvisorFailureKind, string> = {
  config: '配置不完整',
  auth: '鉴权失败',
  model: '模型不可用',
  vision: '不支持图片',
  rate: '限流或额度不足',
  bad_request: '请求被拒绝',
  network: '网络不通',
  timeout: '请求超时',
  server: '服务端故障',
  bad_response: '响应格式异常',
};

/** 每类失败给一句「下一步做什么」（原版 describeAiFailure）。 */
export function describeAiFailure(kind: AdvisorFailureKind): string {
  switch (kind) {
    case 'config': return '配置不完整：接口地址、模型名、API Key 三样都要填。';
    case 'auth': return 'API Key 不对，或不属于这个接口地址对应的平台。';
    case 'model': return '模型名不存在或不可用，请按平台文档核对。';
    case 'vision': return '这个模型不支持图片输入，换一个视觉模型（名字里通常带 vl / vision / v）。';
    case 'rate': return '被限流或额度不足，稍后再试，或到平台看余额 / 并发限制。';
    case 'bad_request': return '请求格式被拒绝：多半是模型名写错，或接口地址不对（应填到 /v1 这一层）。';
    case 'network': return '网络不通或代理问题：确认接口地址能访问，并检查系统代理设置。';
    case 'timeout': return '请求超时：可以在设置里调大超时，或检查网络 / 代理。';
    case 'server': return '服务端故障，通常过一会儿就好。';
    case 'bad_response': return '响应格式异常：确认接口是 OpenAI 兼容的 /chat/completions。';
  }
}

export interface AdvisorTestResult {
  ok: boolean;
  /** true = 模型认出了测试图；false = 不支持图片或答错；null = 没走到这一步。 */
  vision: boolean | null;
  kind: AdvisorFailureKind | null;
  model: string;
  latencyMs: number;
  /** 中文结论。★ 已过 scrubAiSecret。 */
  message: string;
  /** 模型的原话（截断到 120 字、已洗凭据），便于判断它到底看没看到图。 */
  reply: string | null;
}
