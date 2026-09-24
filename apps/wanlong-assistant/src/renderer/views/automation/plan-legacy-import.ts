import type { AccountPlan, PlanConfig, ScriptIssue, ScriptMeta } from '../../../main/plans/types';
import { convertLegacyAccountPlan, convertLegacyConfig, convertLegacyScript, legacyPlanChoices } from '../../../main/plans/legacy';

/**
 * The legacy (wanlong-panel) import session: scripts are imported on the 脚本 page and plans on the 任务计划 page,
 * so this state is shared by both pages (`state/plan-import.tsx`) rather than owned by either panel.
 */
export interface LegacyImportState {
  /** Legacy script id → id it was saved under here; they differ when the legacy id was already taken. */
  scriptMap: Readonly<Record<string, string>>;
  /** Parsed legacy plans.json waiting to be mapped onto an account (null until one is chosen). */
  planFile: unknown;
  /** Legacy account whose plan is imported. */
  planAccountId: string;
  message: string;
}

export const EMPTY_LEGACY_IMPORT: LegacyImportState = { scriptMap: {}, planFile: null, planAccountId: '', message: '' };

export interface LegacyScriptFile {
  name: string;
  text(): Promise<string>;
}

export interface LegacyScriptPort {
  scriptValidate(gameId: string, raw: unknown): Promise<ScriptIssue[]>;
  scriptSave(gameId: string, raw: unknown): Promise<ScriptMeta>;
}

/** The id an imported script is saved under: its own unless taken, so an existing script is never overwritten. */
export function importedScriptId(legacyId: string, used: ReadonlySet<string>, suffix: string): string {
  return used.has(legacyId) ? `${legacyId}-import-${suffix}` : legacyId;
}

/**
 * Validates and saves legacy script files one by one (stopping at the first invalid file) and reports which id
 * each legacy script ended up under.
 */
export async function importLegacyScripts(
  api: LegacyScriptPort,
  gameId: string,
  packageName: string,
  files: readonly LegacyScriptFile[],
  existingIds: Iterable<string>,
  suffix: () => string = () => crypto.randomUUID().slice(0, 6),
): Promise<{ mapping: Record<string, string>; message: string }> {
  const warnings: string[] = [];
  const mapping: Record<string, string> = {};
  const used = new Set(existingIds);
  for (const file of files) {
    const raw = JSON.parse(await file.text()) as unknown;
    const converted = convertLegacyScript(raw, packageName);
    const legacyId = converted.script.id;
    converted.script.id = importedScriptId(legacyId, used, suffix());
    // Structural problems refuse the import; other errors are saved as a draft (refused at run time, shown when edited).
    const errors = (await api.scriptValidate(gameId, converted.script)).filter((issue) => issue.level === 'error' && issue.fatal);
    if (errors.length) throw new Error(`${file.name}：${errors.map((issue) => issue.message).join('；')}`);
    const saved = await api.scriptSave(gameId, converted.script);
    mapping[legacyId] = saved.id;
    used.add(saved.id);
    warnings.push(...converted.warnings.map((item) => `${file.name}：${item}`));
  }
  return { mapping, message: `已导入 ${Object.keys(mapping).length} 个脚本。${warnings.join(' ')}` };
}

/** Remembers where imported scripts went so a later plan import points its tasks at them. */
export function withImportedScripts(state: LegacyImportState, mapping: Record<string, string>, message: string): LegacyImportState {
  return { ...state, scriptMap: { ...state.scriptMap, ...mapping }, message };
}

/** Loads a parsed legacy plans.json and preselects its first account. Throws on a file that is not one. */
export function withLegacyPlanFile(state: LegacyImportState, planFile: unknown): LegacyImportState {
  const choices = legacyPlanChoices(planFile);
  return {
    ...state, planFile, planAccountId: choices[0]?.accountId ?? '',
    message: `旧计划含 ${choices.length} 个账号。选择要映射的旧账号，再导入到当前账号。`,
  };
}

/**
 * The chosen legacy account plan mapped onto `accountId`, with every task pointing at the id its script was
 * imported under. Throws when a task's script is not in the library.
 */
export function legacyPlanForAccount(
  state: LegacyImportState,
  accountId: string,
  availableScriptIds: Iterable<string>,
): { plan: AccountPlan; config: Partial<PlanConfig>; warnings: string[] } {
  const converted = convertLegacyAccountPlan(state.planFile, state.planAccountId, accountId);
  const plan: AccountPlan = {
    ...converted.plan,
    tasks: converted.plan.tasks.map((task) => ({ ...task, scriptId: state.scriptMap[task.scriptId] ?? task.scriptId })),
  };
  const available = new Set(availableScriptIds);
  const missing = [...new Set(plan.tasks.map((task) => task.scriptId).filter((id) => !available.has(id)))];
  if (missing.length) throw new Error(`请先导入这些脚本：${missing.join('、')}`);
  return { plan, config: convertLegacyConfig(state.planFile), warnings: converted.warnings };
}
