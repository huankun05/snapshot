/*
 * 剪贴板图像写入序号（2026-09-28 超清放大配套）：
 * 「超清」模式下确认截图会先复制原图，再在后台异步超分、完成后替换剪贴板内容。
 * 替换前必须确认期间用户没有写入过新的剪贴板图像（又截图/贴图复制等）——
 * 否则会把用户刚复制的新内容覆盖掉。所有图像剪贴板写入点都调用 bump()。
 */
let seq = 0;

/** 记录一次图像剪贴板写入，返回本次序号 */
export function bumpClipboardImageSeq(): number {
  return ++seq;
}

/** 当前序号（与写入时返回值不一致 = 期间有新写入，超分结果应丢弃） */
export function getClipboardImageSeq(): number {
  return seq;
}
