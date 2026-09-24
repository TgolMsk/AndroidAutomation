/**
 * 资源统计的**纯**出口：契约 / 金额解析与格式化 / 快照渲染 / 表格几何 / 模板 id 与裁模板计划。
 *
 * ★ 这里转出的模块一律不 import node:* / sharp / opencv / electron，渲染进程与机器人可以放心用。
 *   `@avdm/automation/wanlong/pure` 应整体转出本文件（export * from './resources/pure.js'）。
 */

export * from './contract.js'
export * from './layout.js'
export * from './ids.js'
