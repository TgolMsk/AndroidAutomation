#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command, Help } from 'commander';
import type { Argument, Option } from 'commander';
import { registerDeviceCommands } from './commands/device.js';
import { registerDiagnoseCommand } from './commands/diagnose.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerInstanceCommands } from './commands/instances.js';
import { registerLifecycleCommands } from './commands/lifecycle.js';
import { registerMonitorCommand } from './commands/monitor.js';
import { registerScriptCommands } from './commands/script.js';
import { registerSdkCommands } from './commands/sdk.js';
import { registerSettingsCommands } from './commands/settings.js';
import { ce } from './ui/colors.js';
import { displayWidth } from './ui/table.js';
import { flushAndExit, reportError } from './runtime.js';

/**
 * `avdm` — command line front end of the AVD 多开管理器, built on @avdm/core's AvdManager.
 * This file only wires the commander program; commands live in ./commands/*.
 */

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ───────────────────────────── Help / error localisation ─────────────────────────────

const TITLES: Record<string, string> = {
  'Usage:': '用法:',
  'Options:': '选项:',
  'Commands:': '命令:',
  'Arguments:': '参数:',
  'Global Options:': '全局选项:',
};

function localizeUsage(s: string): string {
  return s.replace(/\[options\]/g, '[选项]').replace(/\[command\]/g, '[命令]');
}

function localizeExtra(s: string): string {
  return s
    .replace(/\(default: /g, '(默认: ')
    .replace(/, default: /g, ', 默认: ')
    .replace(/choices: /g, '可选: ')
    .replace(/preset: /g, '预设: ')
    .replace(/env: /g, '环境变量: ');
}

/** Translate commander's built-in (English) parse errors. */
export function localizeCommanderError(str: string): string {
  const rules: Array<[RegExp, string]> = [
    [/error: missing required argument '(.+?)'/, "错误: 缺少必需参数 '$1'"],
    [/error: option '(.+?)' argument missing/, "错误: 选项 '$1' 缺少参数值"],
    [/error: required option '(.+?)' not specified/, "错误: 缺少必需选项 '$1'"],
    [/error: unknown option '(.+?)'/, "错误: 未知选项 '$1'"],
    [/error: unknown command '(.+?)'/, "错误: 未知命令 '$1'"],
    [
      /error: too many arguments(?: for '(.+?)')?\. Expected (\d+) arguments? but got (\d+): (.*)\./,
      '错误: 参数过多（需要 $2 个，收到 $3 个: $4）',
    ],
    [/error: option '(.+?)' argument '(.*?)' is invalid\./, "错误: 选项 '$1' 的值 '$2' 无效。"],
    [/error: option '(.+?)' value '(.*?)' from env '(.+?)' is invalid\./, "错误: 环境变量 $3 中选项 '$1' 的值 '$2' 无效。"],
    [/error: command-argument value '(.*?)' is invalid for argument '(.+?)'\./, "错误: 参数 '$2' 的值 '$1' 无效。"],
    [/error: (.+?) cannot be used with (.+)/, '错误: $1 不能与$2 同时使用'],
    [/Allowed choices are (.+?)\./, '可选值: $1。'],
    [/\(Did you mean one of (.+?)\?\)/, '（是否想输入以下之一: $1？）'],
    [/\(Did you mean (.+?)\?\)/, '（是否想输入 $1？）'],
    [/\boption '/g, "选项 '"],
    [/^error: /m, '错误: '],
  ];
  let out = str;
  for (const [re, rep] of rules) out = out.replace(re, rep);
  out = out.replace(/无效。 /g, '无效。').replace(/不能与(?!选项)/g, '不能与 ');
  // Colour the leading "错误:" on a TTY.
  return out.replace(/^错误:/m, ce().red('错误:'));
}

// ───────────────────────────── Program ─────────────────────────────

export function buildProgram(): Command {
  const base = new Help();
  const program = new Command('avdm');
  program
    .description('AVD 多开管理器：基于官方 Android Emulator（arm64 / HVF）的多实例管理工具')
    .version(readVersion(), '-V, --version', '显示版本号')
    .helpOption('-h, --help', '显示帮助')
    .helpCommand('help [命令]', '显示命令帮助')
    .configureHelp({
      styleTitle: (s: string) => TITLES[s] ?? s,
      styleUsage: (s: string) => localizeUsage(s),
      subcommandTerm: (cmd: Command) => localizeUsage(base.subcommandTerm(cmd)),
      optionDescription: (o: Option) => localizeExtra(base.optionDescription(o)),
      argumentDescription: (a: Argument) => localizeExtra(base.argumentDescription(a)),
      displayWidth: (s: string) => displayWidth(s),
    })
    .configureOutput({
      outputError: (str, write) => write(localizeCommanderError(str)),
    })
    .showHelpAfterError(ce().gray('（使用 --help 查看用法）'));

  // Order here is the order shown in `avdm --help`.
  registerDoctorCommand(program);
  registerSdkCommands(program);
  registerInstanceCommands(program);
  registerLifecycleCommands(program);
  registerDeviceCommands(program);
  registerDiagnoseCommand(program);
  registerMonitorCommand(program);
  registerScriptCommands(program);
  registerSettingsCommands(program);

  program.addHelpText(
    'after',
    `
实例选择器 <sel>: all | 3 | 0,2,5 | 1-4 | 0,3-5,9
所有命令都支持 --json 输出机器可读结果；设置 AVDM_HOME 可更换数据目录（默认 ~/.avdm）。

快速开始:
  avdm doctor                 体检环境
  avdm sdk install            安装 emulator / platform-tools / 默认镜像（需同意许可）
  avdm create -n 3            新建 3 个实例
  avdm start all --wait       启动全部并等待开机
  avdm list                   查看状态
  avdm view 0                 用 scrcpy 查看 #0 画面`,
  );
  return program;
}

async function main(): Promise<void> {
  // `avdm list | head -1`: the reader went away — not an error.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(Number(process.exitCode ?? 0) || 0);
  });
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    reportError(err);
    const code = Number(process.exitCode ?? 0) || 0;
    process.exitCode = code === 0 ? 1 : code;
  }
  await flushAndExit(Number(process.exitCode ?? 0) || 0);
}

/** True when this module is the process entry point (not when imported, e.g. by tests). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) void main();
