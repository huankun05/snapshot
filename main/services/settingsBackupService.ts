/*
 * eIsland - A sleek, Apple Dynamic Island inspired floating widget for Windows, built with Electron.
 * https://github.com/JNTMTMTM/eIsland
 *
 * Copyright (C) 2026 JNTMTMTM
 * Copyright (C) 2026 pyisland.com
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * @file settingsBackupService.ts
 * @description 设置数据备份（2026-11-23，通用页「保存」分组）：
 *   - 立即备份：eIsland_store 全部 JSON 打包成单文件（settings-时间戳.json），滚动保留 10 份
 *   - 导出：另存对话框（跨机器迁移）
 *   - 导入：整体替换语义——写回前自动做「导入前备份」防误操作；导入后需重启应用生效
 *   备份内容不含账号凭据（user-account-token 白名单排除）。
 */
import { BrowserWindow, dialog } from 'electron';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { app } from 'electron';
import { readSettingsBackupDirConfig } from '../config/storeConfig';

/** 备份文件名前缀（导入前备份再加 -pre 前缀，恢复默认目录时也能按前缀识别滚动清理） */
const BACKUP_PREFIX = 'settings-';
const KEEP_COUNT = 10;
/** 不进备份的键：账号凭据类（隐私；换机器也不该带过去） */
const EXCLUDED_KEYS = new Set(['user-account-token']);

function storeDir(): string {
  return join(app.getPath('userData'), 'eIsland_store');
}

/** 备份目录：设置可配，空 = 文档\petalsnap-backup */
export function resolveBackupDir(): string {
  const custom = readSettingsBackupDirConfig();
  if (custom) return custom;
  return join(app.getPath('documents'), 'petalsnap-backup');
}

/** 本壳标记：写进备份，恢复时用于拦截「跨壳整体替换」（F2 的 store 只有少量键，
 *  拿它整体替换 F1 会把几十个设置键清空 —— 数据丢失级风险，2026-11-25）。 */
const SHELL_TAG = 'f1';

/** 本地时间戳（2026-11-25 改）：原用 toISOString 是 UTC，与列表显示的本地时间差 8 小时，
 *  用户看到「文件名 13:26 / 显示 21:26」以为日期错了。文件名与展示统一走本地。 */
function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** 打包 store 全部 JSON：{ [storeKey]: value }；返回文件内容字符串 */
export function packStore(): string {
  const dir = storeDir();
  const out: Record<string, unknown> = { __format: 'petalsnap-settings-backup/1', __shell: SHELL_TAG };
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const key = basename(f, '.json');
      if (EXCLUDED_KEYS.has(key)) continue;
      try {
        out[key] = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      } catch {
        // 单个文件损坏不阻塞整体备份，跳过并在内容里留痕
        out[key] = null;
      }
    }
  }
  return JSON.stringify(out, null, 2);
}

/** 滚动清理：同前缀备份按文件名倒序，保留最近 KEEP_COUNT 份 */
function pruneOld(dir: string, prefix: string): void {
  try {
    const olds = readdirSync(dir)
      .filter((f) => f.startsWith(`${prefix}`) && f.endsWith('.json'))
      .sort()
      .reverse();
    for (const f of olds.slice(KEEP_COUNT)) {
      try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function writeBackup(dir: string, filename: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const fp = join(dir, filename);
  writeFileSync(fp, content, 'utf-8');
  pruneOld(dir, BACKUP_PREFIX);
  return fp;
}

/** 立即备份到备份目录；返回 {文件路径, 数量} */
export function backupNow(): { ok: boolean; path?: string; count?: number; message?: string } {
  try {
    const content = packStore();
    const count = Object.keys(JSON.parse(content)).filter((k) => !k.startsWith('__')).length;
    const fp = writeBackup(resolveBackupDir(), `${BACKUP_PREFIX}${timestamp()}.json`, content);
    return { ok: true, path: fp, count };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** 导出：另存对话框。挂设置窗为父窗口（与截图保存对话框同款置顶处理） */
export async function exportSettings(parent: BrowserWindow | null): Promise<{ ok: boolean; path?: string; message?: string }> {
  try {
    const content = packStore();
    const options: Electron.SaveDialogOptions = {
      title: '导出设置',
      defaultPath: join(app.getPath('documents'), `petalsnap-settings-${timestamp()}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    };
    const result = parent && !parent.isDestroyed()
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { ok: false, message: 'canceled' };
    writeFileSync(result.filePath, content, 'utf-8');
    return { ok: true, path: result.filePath };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** 导入前校验：JSON + __format 标记 + 全部键是字符串键。返回解析后的 store 映射 */
function parseBackupFile(raw: string): Record<string, unknown> {
  const data = JSON.parse(raw) as Record<string, unknown>;
  if (!data || typeof data !== 'object' || data.__format !== 'petalsnap-settings-backup/1') {
    throw new Error('不是有效的拾花设置备份文件');
  }
  return data;
}

/** 跨壳判定：有标记且不是本壳 = 外来；无标记 = 旧版备份（无法确认来源）。
 *  两者都不许默认整体替换，必须用户显式选「合并」才写。 */
function foreignKind(data: Record<string, unknown>): '' | 'foreign' | 'legacy' {
  const tag = typeof data.__shell === 'string' ? data.__shell : '';
  if (!tag) return 'legacy';
  return tag === SHELL_TAG ? '' : 'foreign';
}

function foreignMessage(kind: 'foreign' | 'legacy', data: Record<string, unknown>): string {
  if (kind === 'legacy') return '这是旧版备份（没有壳标记），无法确认来源；建议按键合并，不整体替换';
  const other = data.__shell === 'f2' ? 'Tauri 壳（F2）' : 'Electron 壳（F1）';
  return `这是 ${other} 的备份，两个壳的设置存储不同构；直接恢复会清空当前壳的设置，建议按键合并`;
}

/** 写回 store：merge=true 逐键覆盖（保留备份里没有的键）；false 整体替换（先清空） */
function writeStore(data: Record<string, unknown>, merge: boolean): number {
  const dir = storeDir();
  mkdirSync(dir, { recursive: true });
  if (!merge && existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json') || EXCLUDED_KEYS.has(basename(f, '.json'))) continue;
      try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
    }
  }
  let count = 0;
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith('__') || EXCLUDED_KEYS.has(key)) continue;
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(value), 'utf-8');
    count += 1;
  }
  return count;
}

/** 上一次导入选中的文件：跨壳/旧版备份被拦下后，用户点「仍要导入（合并）」不必再选一次文件 */
let lastImportPick: string | null = null;

/** 导入（整体替换语义）：写回前自动在备份目录做一份「导入前备份」，可一键回退。 */
export async function importSettings(parent: BrowserWindow | null, opts?: { merge?: boolean }): Promise<{ ok: boolean; count?: number; preBackup?: string; message?: string; needMerge?: boolean }> {
  try {
    const merge = opts?.merge === true;
    let pickedPath = merge ? lastImportPick : null;
    if (!pickedPath) {
      const options: Electron.OpenDialogOptions = {
        title: '导入设置',
        defaultPath: app.getPath('documents'),
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      };
      const picked = parent && !parent.isDestroyed()
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, message: 'canceled' };
      pickedPath = picked.filePaths[0];
    }
    lastImportPick = pickedPath;

    const data = parseBackupFile(readFileSync(pickedPath, 'utf-8'));
    const kind = foreignKind(data);
    if (kind && !merge) {
      return { ok: false, needMerge: true, message: foreignMessage(kind, data) };
    }

    // 导入前备份（写进常规滚动队列，文件名带 -pre 标记便于识别）
    const pre = writeBackup(resolveBackupDir(), `${BACKUP_PREFIX}${timestamp()}-pre-import.json`, packStore());
    const count = writeStore(data, merge || !!kind);
    return { ok: true, count, preBackup: pre };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** 打开备份目录（设置页「打开」按钮） */
export function openBackupDir(): void {
  const dir = resolveBackupDir();
  mkdirSync(dir, { recursive: true });
  // shell.openPath 由调用方（main.ts）统一处理，这里只负责建目录 + 返回
}

// ===== 备份列表与一键恢复（2026-11-24）=====

export type BackupEntry = { name: string; size: number; mtime: number };

/** 备份列表（新→旧），仅 settings-*.json */
export function listBackups(): BackupEntry[] {
  const dir = resolveBackupDir();
  const out: BackupEntry[] = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!(f.startsWith(BACKUP_PREFIX) && f.endsWith('.json'))) continue;
      try {
        const st = statSync(join(dir, f));
        out.push({ name: f, size: st.size, mtime: st.mtimeMs });
      } catch { /* ignore */ }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** 恢复到指定备份（同壳=整体替换；跨壳/旧版=必须显式 merge，按键合并） */
export function restoreBackup(name: string, opts?: { merge?: boolean }): { ok: boolean; count?: number; message?: string; needMerge?: boolean } {
  if (!name || name.includes('/') || name.includes(String.fromCharCode(92)) || name.includes('..')) {
    return { ok: false, message: '非法备份文件名' };
  }
  const fp = join(resolveBackupDir(), name);
  if (!existsSync(fp)) return { ok: false, message: '备份文件不存在' };
  try {
    const merge = opts?.merge === true;
    const data = parseBackupFile(readFileSync(fp, 'utf-8'));
    const kind = foreignKind(data);
    if (kind && !merge) {
      return { ok: false, needMerge: true, message: foreignMessage(kind, data) };
    }
    writeBackup(resolveBackupDir(), `${BACKUP_PREFIX}${timestamp()}-pre-import.json`, packStore());
    const count = writeStore(data, merge || !!kind);
    return { ok: true, count };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// ===== 手动删除 + 撤销（2026-11-25 用户反馈：备份只能恢复不能删）=====

/** 删除后暂存内容供撤销；60s 后自动丢弃（浮层只停 6s，留足余量） */
const deletedBackups = new Map<string, { name: string; content: string; at: number }>();

function pruneUndo(): void {
  const now = Date.now();
  for (const [k, v] of deletedBackups) {
    if (now - v.at > 60_000) deletedBackups.delete(k);
  }
}

/** 删除一份备份：不弹确认框（与本应用零弹窗一致），改为浮层内「撤销」 */
export function deleteBackup(name: string): { ok: boolean; token?: string; name?: string; message?: string } {
  if (!name || name.includes('/') || name.includes(String.fromCharCode(92)) || name.includes('..')
    || !name.startsWith(BACKUP_PREFIX) || !name.endsWith('.json')) {
    return { ok: false, message: '非法备份文件名' };
  }
  const fp = join(resolveBackupDir(), name);
  if (!existsSync(fp)) return { ok: false, message: '备份文件不存在' };
  try {
    const content = readFileSync(fp, 'utf-8');
    unlinkSync(fp);
    pruneUndo();
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    deletedBackups.set(token, { name, content, at: Date.now() });
    return { ok: true, token, name };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** 撤销删除：原样写回（不走 writeBackup，避免触发滚动清理误删别的份） */
export function undoDeleteBackup(token: string): { ok: boolean; name?: string; message?: string } {
  const rec = deletedBackups.get(String(token || ''));
  if (!rec) return { ok: false, message: '撤销已过期' };
  try {
    const dir = resolveBackupDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, rec.name), rec.content, 'utf-8');
    deletedBackups.delete(String(token));
    return { ok: true, name: rec.name };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

