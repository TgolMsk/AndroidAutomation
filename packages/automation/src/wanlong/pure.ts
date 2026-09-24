/**
 * 万龙觉醒的纯数据部分：`@avdm/automation/wanlong/pure`。
 *
 * ★ 渲染进程用它拿**唯一一份**默认值与归一化函数（DEFAULT_GATHER_CONFIG / normalizeGatherConfig / RESOURCE_LABEL …），
 *   不要在界面里再抄一份。这里只能导出不依赖 sharp / OpenCV / node:* 的模块。
 */
export * from './config.js'
export * from './constants.js'
export * from './resources/pure.js'
export * from './update-ids.js'
