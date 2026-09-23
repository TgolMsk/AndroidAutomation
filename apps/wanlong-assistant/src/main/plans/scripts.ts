import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from '@avdm/core';
import type { ScriptDef, ScriptIssue, ScriptMeta } from './types';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const MAX_SCRIPT_BYTES = 512 * 1024;
const MAX_STEPS = 300;
const MAX_DEPTH = 8;
const MAX_TEXT = 2048;
const KEY_NAMES = new Set(['BACK', 'HOME', 'ENTER', 'MENU', 'APP_SWITCH', 'DEL', 'ESCAPE', 'VOLUME_UP', 'VOLUME_DOWN']);

const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const bounded = (x: unknown, low: number, high: number): boolean => finite(x) && x >= low && x <= high;
const name = (x: unknown, max = 120): x is string => typeof x === 'string' && x.trim().length > 0 && x.length <= max;
const point = (x: unknown, width: number, height: number): boolean => object(x) && bounded(x.x, 0, width) && bounded(x.y, 0, height);
const rect = (x: unknown, width: number, height: number): boolean => object(x) && bounded(x.x, 0, width) && bounded(x.y, 0, height) &&
  bounded(x.w, 1, width) && bounded(x.h, 1, height) && (x.x as number) + (x.w as number) <= width && (x.y as number) + (x.h as number) <= height;

/** Every saved script is checked before it can reach a device. Old JSON keeps its field names. */
export function validateScript(raw: unknown, expectedPackage: string, templateIds?: readonly string[]): ScriptIssue[] {
  const issues: ScriptIssue[] = [];
  const fail = (message: string, stepId: string | null = null): void => { issues.push({ level: 'error', stepId, message }); };
  const warn = (message: string, stepId: string | null = null): void => { issues.push({ level: 'warn', stepId, message }); };
  if (!object(raw)) return [{ level: 'error', stepId: null, message: '脚本必须是对象' }];
  if (!name(raw.id, 96) || !ID.test(raw.id)) fail('脚本 id 只能包含字母、数字、点、下划线和短横线');
  if (!name(raw.name)) fail('脚本名称无效');
  if (!name(raw.version, 32)) fail('脚本版本无效');
  if (!bounded(raw.refWidth, 1, 16384) || !bounded(raw.refHeight, 1, 16384)) fail('参考分辨率无效');
  if (raw.packageName !== undefined && raw.packageName !== expectedPackage) fail(`脚本包名必须是 ${expectedPackage}`);
  if (raw.templateSetId !== undefined && (!name(raw.templateSetId, 96) || !ID.test(raw.templateSetId))) fail('模板集 id 无效');
  if (!Array.isArray(raw.steps) || raw.steps.length > MAX_STEPS) fail(`步骤必须是数组且不超过 ${MAX_STEPS} 项`);
  if (raw.loop !== undefined && typeof raw.loop !== 'boolean') fail('循环开关无效');
  if (raw.loop === true) fail('无限循环脚本暂不允许，请使用计划间隔触发');
  if (raw.params !== undefined && (!Array.isArray(raw.params) || raw.params.length > 50)) fail('脚本参数定义无效');
  if (raw.params && Array.isArray(raw.params)) {
    const keys = new Set<string>();
    for (const param of raw.params) {
      if (!object(param) || !name(param.key, 64) || !ID.test(param.key) || keys.has(param.key) ||
        !name(param.label) || !['string', 'number', 'boolean', 'enum'].includes(String(param.type))) fail('参数定义或参数 key 重复');
      else keys.add(param.key);
    }
  }
  const width = finite(raw.refWidth) ? raw.refWidth : 0;
  const height = finite(raw.refHeight) ? raw.refHeight : 0;
  const knownTemplates = templateIds ? new Set(templateIds) : null;
  const knownIds = new Set<string>();
  let count = 0;
  const condition = (value: unknown, depth: number, stepId: string): void => {
    if (!object(value) || depth > MAX_DEPTH) { fail('条件格式或嵌套深度无效', stepId); return; }
    switch (value.kind) {
      case 'always': case 'never': break;
      case 'foreground':
        if (value.packageName !== expectedPackage) fail('前台条件只能检查当前游戏包名', stepId);
        break;
      case 'template':
        if (!name(value.templateId, 96) || !ID.test(value.templateId)) fail('模板条件 id 无效', stepId);
        else if (knownTemplates && !knownTemplates.has(value.templateId)) fail(`模板 ${value.templateId} 不存在`, stepId);
        if (value.roi !== undefined && !rect(value.roi, width, height)) fail('模板 ROI 越界', stepId);
        if (value.threshold !== undefined && !bounded(value.threshold, 0, 1)) fail('模板阈值无效', stepId);
        break;
      case 'anyTemplate':
        if (!Array.isArray(value.templateIds) || !value.templateIds.length || value.templateIds.length > 50) fail('任意模板列表无效', stepId);
        else for (const id of value.templateIds) condition({ kind: 'template', templateId: id, roi: value.roi, threshold: value.threshold }, depth + 1, stepId);
        break;
      case 'and': case 'or': {
        const items = value.kind === 'and' ? value.all : value.any;
        if (!Array.isArray(items) || !items.length || items.length > 30) fail('组合条件列表无效', stepId);
        else items.forEach((item) => condition(item, depth + 1, stepId));
        break;
      }
      case 'not': condition(value.of, depth + 1, stepId); break;
      default: fail('条件类型不受支持', stepId);
    }
  };
  const visit = (steps: unknown, depth: number, ancestors: Set<string>[]): void => {
    if (!Array.isArray(steps) || depth > MAX_DEPTH || steps.length > MAX_STEPS) { fail('步骤列表或嵌套深度无效'); return; }
    const labels = new Set<string>();
    for (const item of steps) if (object(item) && item.kind === 'label' && name(item.label, 96)) {
      if (labels.has(item.label)) fail(`重复 label：${item.label}`, typeof item.id === 'string' ? item.id : null);
      labels.add(item.label);
    }
    const scope = [...ancestors, labels];
    for (const item of steps) {
      count++;
      if (count > MAX_STEPS) { fail(`总步骤数超过 ${MAX_STEPS}`); return; }
      if (!object(item) || !name(item.id, 96) || !ID.test(item.id)) { fail('步骤 id 无效'); continue; }
      const id = item.id;
      if (knownIds.has(id)) fail('步骤 id 重复', id);
      knownIds.add(id);
      if (item.when !== undefined) condition(item.when, 0, id);
      if (item.timeoutMs !== undefined && !bounded(item.timeoutMs, 100, 600_000)) fail('步骤超时应为 100–600000 毫秒', id);
      if (item.retry !== undefined && !bounded(item.retry, 0, 10)) fail('重试次数应为 0–10', id);
      if (item.retryDelayMs !== undefined && !bounded(item.retryDelayMs, 0, 60_000)) fail('重试间隔过大', id);
      if (item.afterDelayMs !== undefined && !bounded(item.afterDelayMs, 0, 60_000)) fail('步骤延时过大', id);
      if (item.onFail !== undefined && (!object(item.onFail) || !['abort', 'continue', 'goto', 'restartApp'].includes(String(item.onFail.kind)))) fail('失败策略无效', id);
      if (object(item.onFail) && item.onFail.kind === 'goto' && (!name(item.onFail.label, 96) || !scope.some((s) => s.has((item.onFail as { label: string }).label)))) fail('失败跳转目标不存在', id);
      switch (item.kind) {
        case 'tap': case 'longPress':
          if (!point(item.at, width, height)) fail('坐标越界', id);
          if (item.kind === 'longPress' && !bounded(item.durationMs, 50, 10_000)) fail('长按时长应为 50–10000 毫秒', id);
          break;
        case 'tapTemplate':
          condition({ kind: 'template', templateId: item.templateId, roi: item.roi, threshold: item.threshold }, 0, id);
          if (item.offset !== undefined && !point({ x: Math.abs((item.offset as { x: number }).x), y: Math.abs((item.offset as { y: number }).y) }, width, height)) fail('模板点击偏移无效', id);
          if (item.waitMs !== undefined && !bounded(item.waitMs, 0, 300_000)) fail('模板等待时长过大', id);
          break;
        case 'waitFor':
          condition(item.cond, 0, id);
          if (!bounded(item.waitMs, 0, 300_000)) fail('等待时长应为 0–300000 毫秒', id);
          break;
        case 'swipe':
          if (!point(item.from, width, height) || !point(item.to, width, height) ||
            (item.durationMs !== undefined && !bounded(item.durationMs, 50, 10_000))) fail('滑动坐标或时长无效', id);
          break;
        case 'text':
          if (typeof item.text !== 'string' || item.text.length > MAX_TEXT) fail('输入文本过长', id);
          else if (/[^\x00-\x7F]/.test(item.text)) fail('当前模拟器输入接口暂不支持中文；请改为 ASCII 或另行接入输入法', id);
          break;
        case 'key': if (!KEY_NAMES.has(String(item.key))) fail('按键不受支持', id); break;
        case 'sleep': if (!bounded(item.ms, 0, 300_000)) fail('等待时长过大', id); break;
        case 'launchApp': case 'stopApp':
          if (item.packageName !== undefined && item.packageName !== expectedPackage) fail('脚本不能操作其他应用包名', id);
          break;
        case 'screenshot': break;
        case 'log': if (!['debug', 'info', 'warn', 'error'].includes(String(item.level)) || typeof item.message !== 'string' || item.message.length > 2048) fail('日志步骤无效', id); break;
        case 'label': if (!name(item.label, 96) || !ID.test(item.label)) fail('label 无效', id); break;
        case 'goto':
          if (!name(item.label, 96) || !scope.some((s) => s.has(item.label as string))) fail('goto 目标不存在或超出作用域', id);
          if (item.maxTimes !== undefined && !bounded(item.maxTimes, 1, 1000)) fail('goto 次数上限无效', id);
          break;
        case 'if': condition(item.cond, 0, id); visit(item.then, depth + 1, scope); if (item.else !== undefined) visit(item.else, depth + 1, scope); break;
        case 'loop':
          if (item.repeat === undefined && item.while === undefined) fail('循环必须配置次数或条件', id);
          if (item.repeat !== undefined && !bounded(item.repeat, 0, 1000)) fail('循环次数应为 0–1000', id);
          if (item.maxIterations !== undefined && !bounded(item.maxIterations, 1, 1000)) fail('循环硬上限无效', id);
          if (item.while !== undefined) condition(item.while, 0, id);
          visit(item.steps, depth + 1, scope);
          break;
        default: fail('步骤类型不受支持', id);
      }
    }
  };
  if (Array.isArray(raw.steps)) visit(raw.steps, 0, []);
  if (Array.isArray(raw.steps) && raw.steps.length === 0) warn('脚本没有步骤');
  return issues;
}

function meta(script: ScriptDef): ScriptMeta {
  return { id: script.id, name: script.name, version: script.version, description: script.description, stepCount: script.steps.length, updatedAt: script.updatedAt };
}

/** Script documents are game scoped, private, and atomically replaced. */
export class ScriptStore {
  constructor(private readonly home: string) { if (!path.isAbsolute(home)) throw new Error('脚本数据目录必须是绝对路径'); }
  private dir(gameId: string): string { if (!ID.test(gameId)) throw new Error('游戏编号无效'); return path.join(this.home, 'automation', 'games', gameId, 'scripts'); }
  private file(gameId: string, id: string): string { if (!ID.test(id)) throw new Error('脚本编号无效'); return path.join(this.dir(gameId), `${id}.json`); }
  async list(gameId: string): Promise<ScriptMeta[]> {
    let files: string[];
    try { files = await readdir(this.dir(gameId)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const out: ScriptMeta[] = [];
    for (const file of files.filter((f) => f.endsWith('.json') && ID.test(f.slice(0, -5)))) {
      try { out.push(meta(await this.get(gameId, file.slice(0, -5)))); }
      catch (error) { out.push({ id: file.slice(0, -5), name: `⚠ 无法读取：${file}`, version: '0', description: String(error), stepCount: 0, updatedAt: 0 }); }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async get(gameId: string, id: string): Promise<ScriptDef> {
    const file = this.file(gameId, id);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SCRIPT_BYTES) throw new Error('脚本文件无效或超过 512 KB');
    const data = JSON.parse(await readFile(file, 'utf8')) as ScriptDef;
    if (!object(data) || data.id !== id) throw new Error('脚本文件 id 不匹配');
    return data;
  }
  async save(gameId: string, expectedPackage: string, raw: unknown, templateIds?: readonly string[]): Promise<ScriptMeta> {
    const issues = validateScript(raw, expectedPackage, templateIds).filter((i) => i.level === 'error');
    if (issues.length) throw new Error(`脚本校验失败：${issues.map((i) => `${i.stepId ?? '脚本'} ${i.message}`).join('；')}`);
    const script = { ...(raw as ScriptDef), packageName: expectedPackage, updatedAt: Date.now() };
    const file = this.file(gameId, script.id);
    await withFileLock(`${file}.lock`, async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(script, null, 2) + '\n'); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temp, file);
        await chmod(file, 0o600);
      } catch (error) { await rm(temp, { force: true }).catch(() => undefined); throw error; }
    });
    return meta(script);
  }
  async remove(gameId: string, id: string): Promise<void> {
    const file = this.file(gameId, id);
    await withFileLock(`${file}.lock`, () => rm(file));
  }
}
