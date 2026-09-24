/**
 * 万龙觉醒的纯数据部分：`@avdm/automation/wanlong/pure`。
 *
 * ★ 渲染进程用它拿**唯一一份**默认值与归一化函数（DEFAULT_GATHER_CONFIG / normalizeGatherConfig / RESOURCE_LABEL …），
 *   不要在界面里再抄一份。这里只能导出不依赖 sharp / OpenCV / node:* 的模块。
 */
export * from './config.js'
// 采集配置的校验 / 宽松还原 / 导入导出（配置页与主进程保存把关共用一份）
export * from './config-validate.js'
export * from './constants.js'
export * from './resources/pure.js'
export * from './update-ids.js'
// ── ETA 调度（队列状态契约、本地递推、疲劳换算、排期）与采集事实：全是纯函数，面板倒计时与主进程排期共用 ──
export * from './scheduler/model.js'
export * from './scheduler/fatigue.js'
export * from './scheduler/state.js'
export * from './scheduler/parse.js'
export * from './gather/facts.js'
