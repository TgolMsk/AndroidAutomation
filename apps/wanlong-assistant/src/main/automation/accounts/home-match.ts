import { loadTemplateSet, probeGame } from '@avdm/automation';
import { gamePlugin } from '../games';
import { HOME_TEMPLATES_MISSING, type HomeVerifyMatch, type HomeVerifyWorkerInput } from './home-verify-contract';

/**
 * Match the game's home templates on one frame (original `verifyGameFrame`): ids missing from the set are
 * skipped, only an empty candidate list is an error, and each template uses its own threshold and default ROI at
 * shrink 2. Runs in `home-verify-worker` (and in the read-only dev script), never on the Electron main thread.
 */
export async function matchHomeTemplates(input: HomeVerifyWorkerInput): Promise<{ matches: HomeVerifyMatch[]; missing: string[] }> {
  const plugin = gamePlugin(input.gameId);
  const set = await loadTemplateSet(input.templateDir);
  const present = input.templateIds.filter((id) => set.templates.some((template) => template.id === id));
  const missing = input.templateIds.filter((id) => !present.includes(id));
  if (present.length === 0) throw new Error(HOME_TEMPLATES_MISSING);
  const report = await probeGame({
    plugin, templateDir: input.templateDir, templateIds: present, shrink: 2,
    device: { capture: async () => input.frame, foregroundPackage: async () => input.foregroundPackage },
  });
  return {
    matches: report.matches.map(({ templateId, found, score, threshold }) => ({ templateId, found, score, threshold })),
    missing,
  };
}
