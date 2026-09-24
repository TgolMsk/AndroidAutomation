import type { RawFrame } from '@avdm/automation';

/**
 * Messages between the main process and `home-verify-worker`, plus their fixed Chinese errors. Kept apart from
 * `home-verify.ts` so the worker bundle never shares a chunk with the main-side runner: the runner resolves the
 * worker file next to its own module URL, which must stay the main entry.
 */
export interface HomeVerifyWorkerInput {
  gameId: string;
  templateDir: string;
  /** Candidate home templates; ids missing from the set are skipped. */
  templateIds: string[];
  foregroundPackage: string | null;
  frame: RawFrame;
}

export interface HomeVerifyMatch {
  templateId: string;
  found: boolean;
  score: number;
  threshold: number;
}

export type HomeVerifyWorkerOutput =
  | { ok: true; matches: HomeVerifyMatch[]; missing: string[] }
  | { ok: false; error: string };

export const HOME_TEMPLATES_MISSING = '缺少城内／世界地图模板，请先在模板库为该实例的模板集配置对应阵营的导航模板。';
/** Raised while the wizard holds the instance, so the way out starts with ending the wizard. */
export const HOME_TEMPLATE_SET_MISSING = '该实例还没有模板集，无法检查是否已进入游戏主界面。请先点「稍后继续」结束登录向导，'
  + '到模板库为该实例选择模板集（需包含城内／世界地图导航模板），再回来点「继续登录」。';
/** Raised before the wizard takes the instance: the template set can still be chosen right away. */
export const HOME_TEMPLATE_SET_REQUIRED = '该实例还没有模板集，登录后无法检查是否已进入游戏主界面。'
  + '请先到模板库为该实例选择模板集（需包含城内／世界地图导航模板），再开始登录。';
