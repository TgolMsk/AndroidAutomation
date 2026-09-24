/**
 * 统一错误模型：AppError / serializeError 只有一份实现，在包根的 errors.ts。
 *
 * ★ 视觉层（vision.ts / templates.ts / template-library.ts）与游戏模块抛的是**同一个** AppError 类，
 *   `AppError.from(e).code` 才不会把 TEMPLATE_LOW_VARIANCE 之类的码包成 UNKNOWN。
 */
export { AppError, errorCodeOf, isSerializedError, serializeError } from '../errors.js'
export type { SerializedError } from '../errors.js'
