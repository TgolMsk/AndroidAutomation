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
export const HOME_TEMPLATE_SET_MISSING = '请先在模板库为该实例选择模板集（需包含城内／世界地图导航模板），再检查登录。';
