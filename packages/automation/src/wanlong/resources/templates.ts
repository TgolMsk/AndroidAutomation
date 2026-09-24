/**
 * 单位字（亿/万）的 shrink=1 加载，以及把用户提供的截图按规格裁成模板入库的执行器。
 *
 * 分类与编译倍率见 ids.ts 文件头。本文件只做两件有副作用的事：
 *   · loadResourceUnitTemplates —— 从**调用方给的模板集目录**里读单位字并按 shrink=1 编译（带缓存）
 *   · seedResourceTemplates     —— 按 resourceSeedPlan 从截图裁模板，走 TemplateLibrary.save 正式通道
 *
 * ★ 模板永远来自用户自己的模板集目录（不进仓库、不进安装包）；本模块从不在仓库或安装目录里找图。
 */

import sharp from 'sharp'
import type { PreparedTemplate, Rect, TemplateSet } from '../../contracts.js'
import type { TemplateLibrary } from '../../template-library.js'
import { readTemplatePng } from '../../templates.js'
import { prepareTemplate } from '../../vision.js'
import { loadTemplateSetOrExplain } from '../template-dir.js'
import {
  RES_TPL,
  RESOURCE_SEED_FRAME_LABEL,
  RESOURCE_TEMPLATE_CATALOG,
  resourceSeedPlan,
  type ResourceSeedFrame,
  type ResourceTemplateSpec
} from './ids.js'

/** 规格的参考分辨率（resource-stats.json 的 refWidth/refHeight）。 */
const SPEC_W = 2560
const SPEC_H = 1440

// ── 单位字（shrink=1）加载 ─────────────────────────────────────────────────

export interface ResourceUnitTemplates {
  setId: string
  /** 模板集目录（真实路径）。 */
  directory: string
  /** id -> shrink=1 的模板；缺失的 id 不在表里。 */
  units: Map<string, PreparedTemplate>
  /** 缺失（或编译失败）的单位字 id（中文说明用）。 */
  missing: string[]
}

interface UnitCacheEntry {
  signature: string
  value: ResourceUnitTemplates
}

/** 按目录缓存。签名里含单位字定义（文件名每次保存都会变），模板页重裁后自动失效。 */
const unitCache = new Map<string, UnitCacheEntry>()

/**
 * 按 shrink=1 编译单位字模板（只编这两张，不把整集重编一遍）。
 * 缺失的单位字只记进 missing，不抛 —— 「万」在现有截图里本来就没有。
 *
 * @param templateDir 调用方选定的模板集目录（与 loadGatherTemplates 同一个）
 * @param onWarn 编译失败时的中文提示（可选；不传就静默，结果里照样有 missing）
 * @throws AppError('TEMPLATE_NOT_FOUND') 模板集目录不存在 / 读不了 / 清单损坏（中文说明，不外泄原始 Node 错误）
 */
export async function loadResourceUnitTemplates(
  templateDir: string,
  onWarn?: (message: string) => void
): Promise<ResourceUnitTemplates> {
  const set = await loadTemplateSetOrExplain(templateDir, '加载不了单位字模板（亿/万）')
  // loadTemplateSet 返回的 directory 已是真实路径（缓存键）。
  const directory = set.directory
  const ids = [RES_TPL.unitYi, RES_TPL.unitWan]
  const defs = ids.map((id) => set.templates.find((t) => t.id === id) ?? null)
  const signature = JSON.stringify([set.id, set.refWidth, set.refHeight, defs])
  const hit = unitCache.get(directory)
  if (hit && hit.signature === signature) return hit.value

  const units = new Map<string, PreparedTemplate>()
  const missing: string[] = []
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!
    const def = defs[i]
    if (!def) {
      missing.push(id)
      continue
    }
    try {
      const png = await readTemplatePng(set, id)
      units.set(id, await prepareTemplate(png, def, set, 1))
    } catch (e) {
      missing.push(id)
      onWarn?.(`单位字模板「${id}」编译失败，已跳过：${errMsg(e)}`)
    }
  }
  const value: ResourceUnitTemplates = { setId: set.id, directory, units, missing }
  unitCache.set(directory, { signature, value })
  return value
}

/** 模板库变了（重裁 / 导入）时调一次。★ 缓存本来就按单位字定义签名自动失效，这里是显式兜底。 */
export function invalidateResourceUnitTemplates(): void {
  unitCache.clear()
}

// ── seed：把截图按规格裁成模板入库 ─────────────────────────────────────────

export interface SeedResourceTemplatesOptions {
  /** 写模板的正式通道：原子写、std<12 守卫、尺寸校验都在 TemplateLibrary.save 里。 */
  library: Pick<TemplateLibrary, 'save'>
  /** 目标模板集目录（用户选定）。 */
  templateDir: string
  /**
   * 按帧角色给的 PNG 原图（整帧截图，16:9；2560x1440 最准）。
   * 缺哪一帧，从那一帧裁的条目就记进 skipped。
   */
  frames: Partial<Record<ResourceSeedFrame, Uint8Array>>
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
  /** 覆盖模板目录（测试用）。默认 RESOURCE_TEMPLATE_CATALOG。 */
  catalog?: readonly ResourceTemplateSpec[]
}

export interface SeedResourceTemplatesResult {
  setId: string
  saved: string[]
  /** 规格里没有素材、或没给对应帧的条目。 */
  skipped: Array<{ id: string; reason: string }>
  /** 保存被拒的条目（纹理不足、尺寸不符……），附中文原因。 */
  failed: Array<{ id: string; reason: string }>
}

/**
 * 按规格把截图裁成模板，逐张走 TemplateLibrary.save（同 id 覆盖，幂等；std<12 由它拒绝）。
 * 一张失败不影响其它张（记进 failed，不抛）；全部做完后作废单位字缓存。
 * ★ 采集流程与调度器各自的模板缓存由调用方作废（本包不持有它们）。
 * @throws AppError('TEMPLATE_NOT_FOUND') 只有模板集目录本身读不出来时才抛（中文说明）
 */
export async function seedResourceTemplates(opts: SeedResourceTemplatesOptions): Promise<SeedResourceTemplatesResult> {
  const log = opts.log ?? ((): void => undefined)
  const set: TemplateSet = await loadTemplateSetOrExplain(opts.templateDir, '资源统计模板没法入库')
  const plan = resourceSeedPlan(opts.catalog ?? RESOURCE_TEMPLATE_CATALOG)
  const saved: string[] = []
  const skipped = [...plan.skipped]
  const failed: Array<{ id: string; reason: string }> = []
  for (const s of plan.skipped) log('warn', `模板「${s.id}」${s.reason}`)

  const frameInfo = new Map<ResourceSeedFrame, { png: Uint8Array; width: number; height: number } | string>()
  const frameOf = async (frame: ResourceSeedFrame): Promise<{ png: Uint8Array; width: number; height: number } | string> => {
    const cached = frameInfo.get(frame)
    if (cached !== undefined) return cached
    const png = opts.frames[frame]
    let info: { png: Uint8Array; width: number; height: number } | string
    if (!png) {
      info = `没有提供「${RESOURCE_SEED_FRAME_LABEL[frame]}」这一帧`
    } else {
      try {
        const meta = await sharp(Buffer.from(png.buffer, png.byteOffset, png.byteLength)).metadata()
        const width = meta.width ?? 0
        const height = meta.height ?? 0
        if (!width || !height) info = `「${RESOURCE_SEED_FRAME_LABEL[frame]}」不是有效的 PNG`
        else if (Math.abs(width / height - SPEC_W / SPEC_H) > 0.03) {
          info = `「${RESOURCE_SEED_FRAME_LABEL[frame]}」是 ${width}×${height}，不是 16:9 的整帧截图`
        } else info = { png, width, height }
      } catch (e) {
        info = `「${RESOURCE_SEED_FRAME_LABEL[frame]}」读不出来：${errMsg(e)}`
      }
    }
    frameInfo.set(frame, info)
    return info
  }

  for (const d of plan.drafts) {
    const f = await frameOf(d.frame)
    if (typeof f === 'string') {
      skipped.push({ id: d.id, reason: f })
      log('warn', `模板「${d.id}」跳过：${f}`)
      continue
    }
    try {
      await opts.library.save(set.directory, {
        id: d.id,
        name: d.name,
        image: f.png,
        authoredWidth: f.width,
        authoredHeight: f.height,
        crop: scaleRect(d.crop, f.width / SPEC_W, f.height / SPEC_H, f.width, f.height),
        ...(d.defaultRoi
          ? { defaultRoi: scaleRect(d.defaultRoi, set.refWidth / SPEC_W, set.refHeight / SPEC_H, set.refWidth, set.refHeight) }
          : {}),
        ...(d.tags ? { tags: d.tags } : {}),
        note: d.note
      })
      saved.push(d.id)
      log('info', `模板「${d.id}」已入库（${RESOURCE_SEED_FRAME_LABEL[d.frame]} ${JSON.stringify(d.crop)}）`)
    } catch (e) {
      const reason = errMsg(e)
      failed.push({ id: d.id, reason })
      log('warn', `模板「${d.id}」入库失败：${reason}`)
    }
  }

  invalidateResourceUnitTemplates()
  return { setId: set.id, saved, skipped, failed }
}

/** 参考坐标矩形按比例换算并夹进画面（至少 3px，与 TemplateLibrary 的下限一致）。 */
function scaleRect(r: Rect, sx: number, sy: number, maxW: number, maxH: number): Rect {
  const x = Math.max(0, Math.min(maxW - 3, Math.round(r.x * sx)))
  const y = Math.max(0, Math.min(maxH - 3, Math.round(r.y * sy)))
  const w = Math.max(3, Math.min(maxW - x, Math.round(r.w * sx)))
  const h = Math.max(3, Math.min(maxH - y, Math.round(r.h * sy)))
  return { x, y, w, h }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
