/**
 * 读调用方给的模板集目录，读不出来时翻成**能指导用户操作的中文** TEMPLATE_NOT_FOUND。
 *
 * ★ 资源统计的单位字加载 / 资源统计模板入库 / 旧版更新模板导入都走这里：
 *   原始 Node 错误（「ENOENT: no such file or directory, realpath …」）是英文、还带着整条内部路径，
 *   不能原样甩给界面。常见错误码翻成人话，其余原样给 message（loadTemplateSet 自己的校验本来就是中文）。
 */

import type { TemplateSet } from '../contracts.js'
import { loadTemplateSet } from '../templates.js'
import { AppError } from './errors.js'

/**
 * @param templateDir 调用方选定的模板集目录
 * @param purpose 读不出来时这件事做不成了的中文说明，例如「加载不了单位字模板（亿/万）」
 * @throws AppError('TEMPLATE_NOT_FOUND') 目录不存在 / 读不了 / 清单损坏
 */
export async function loadTemplateSetOrExplain(templateDir: string, purpose: string): Promise<TemplateSet> {
  try {
    return await loadTemplateSet(templateDir)
  } catch (e) {
    throw new AppError(
      'TEMPLATE_NOT_FOUND',
      `读取模板集「${templateDir}」失败（${describeTemplateSetError(e)}），${purpose}。请在「模板」页重新选择模板集。`,
      { templateDir }
    )
  }
}

/** 模板集读不出来的原因（中文）。 */
export function describeTemplateSetError(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code
  if (code === 'ENOENT') return '目录不存在或缺少 manifest.json'
  if (code === 'EACCES' || code === 'EPERM') return '没有读取权限'
  if (code === 'ENOTDIR') return '路径不是目录'
  if (e instanceof SyntaxError) return 'manifest.json 不是有效的 JSON'
  return e instanceof Error ? e.message : String(e)
}
