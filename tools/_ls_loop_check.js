/* lsAutoStepLoop + lsWaitMotion 逻辑沙盘回归（r51）：
 * 从 resources/capture.js 提取生产源码（lsGdiGray/lsWaitQuiet/lsWaitMotion/lsAutoStepLoop），
 * 在 stub 环境中跑三个场景：正常步进 / 滚轮被吞(补发恢复) / 页面到底(自动收尾)。
 * 时间为虚拟时钟：Date.now/setTimeout 全部确定性推进（生产原值 900ms 窗口/100ms 轮询），
 * 不依赖真实定时器精度，结果可复现。
 * 用法: node _ls_loop_check.js  */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'capture.js'), 'utf8');

/** 按函数名提取源码（大括号配平，保留 async 前缀） */
function extractFn(name) {
  let idx = src.indexOf(`async function ${name}`);
  if (idx < 0) idx = src.indexOf(`function ${name}`);
  if (idx < 0) throw new Error(`fn not found: ${name}`);
  let depth = 0, opened = false;
  for (let j = src.indexOf('{', idx); j < src.length; j++) {
    if (src[j] === '{') { depth++; opened = true; }
    else if (src[j] === '}') { depth--; if (opened && depth === 0) return src.slice(idx, j + 1); }
  }
  throw new Error('unbalanced braces for ' + name);
}
function extractConstVal(name) {
  const m = src.match(new RegExp(`(?:const|let) ${name} = ([^;]+);`));
  if (!m) throw new Error('const not found: ' + name);
  return m[1];
}

/** 合成 BGRA 帧（灰度恒 grayVal）——喂给生产版 lsGdiGray */
function gdiFrame(grayVal, w = 60, h = 40) {
  const buf = new Uint8Array(w * h * 4);
  for (let j = 0; j < w * h; j++) { buf[j * 4] = grayVal; buf[j * 4 + 1] = grayVal; buf[j * 4 + 2] = grayVal; buf[j * 4 + 3] = 255; }
  return { buf, w, h };
}

async function runScenario(name, gdiOnCall, hooks = {}) {
  const log = [];
  let gdiCalls = 0, stepCalls = 0, fullSteps = 0, finished = false;
  const toasts = [];

  // ── 虚拟时钟：setTimeout 挂队列，泵按最早到期时间推进 vnow，逐项触发 ──
  let vnow = 0;
  const timers = [];
  let timerSeq = 0;
  const setTimeoutV = (fn, ms) => { timers.push({ at: vnow + (ms || 0), fn, id: ++timerSeq }); return timerSeq; };
  const clearTimeoutV = (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); };
  let pumpSteps = 0;
  const pumpDone = (() => { let resolve; const p = new Promise((r) => { resolve = r; }); p.resolve = resolve; return p; })();
  function pump() {
    if (!timers.length) { pumpDone.resolve(); return; }
    if (++pumpSteps > 200000) { pumpDone.resolve(); return; }
    timers.sort((a, b) => a.at - b.at || a.id - b.id);
    const t = timers.shift();
    vnow = t.at;
    t.fn();
    setImmediate(pump); // 让 fn() 触发的微任务（await 续体）先跑完
  }

  const sb = {
    console: { error: (...a) => log.push(a.map(String).join(' ')), log: () => { } },
    window: { devicePixelRatio: 1 },
    setTimeout: setTimeoutV,
    clearTimeout: clearTimeoutV,
    Date: { now: () => vnow },
    Math, Promise,
    LS_MOTION_WAIT_MS: Number(extractConstVal('LS_MOTION_WAIT_MS')),
    LS_AUTO_STEP_GAP_MS: Number(extractConstVal('LS_AUTO_STEP_GAP_MS')),
    LS_MULTI_WHEEL_GAP_MS: Number(extractConstVal('LS_MULTI_WHEEL_GAP_MS')),
    lsAutoTargetFrac: Number(extractConstVal('lsAutoTargetFrac')),
    selX: 10, selY: 10, selW: 100, selH: 80,
    longShotActive: true, lsAutoScrollActive: true, lsAutoStepToken: 1,
    lsAutoDelta: -24, lsAutoCalib: true, lsAutoProbe: -24,
    lsLastGoodS: 0, lsCh: 524, lsLastStepAppended: false,
    lsAcceptCount: 0, lsAutoRampScale: 0,
    lsAutoSnapMode: false, lsAutoMultiWheel: 1, lsAutoSnapStreak: 0, lsRejectStreak: 0,
    lsSetHealth: () => { },
    lsAcceptCount: 0,
    lsMotionUntil: 0, lsLastFullAt: 0,
    lsDiagDue: () => true,
    ipcRenderer: {
      invoke: async (_ch, p) => {
        if (_ch === 'capture-ls-autoscroll') { stepCalls++; log.push(`STEP#${stepCalls} delta=${p.delta}`); return true; }
        if (_ch === 'capture-longshot-gdi') { gdiCalls++; return gdiOnCall({ gdiCalls, stepCalls }); }
        return null;
      },
    },
    showToastMessage: (m) => toasts.push(m),
    stopLongScreenshot: (save) => { finished = true; log.push(`FINISH save=${save}`); },
    lsFullStep: async () => {
      fullSteps++;
      log.push(`FULLSTEP#${fullSteps}`);
      if (hooks.onFullStep) hooks.onFullStep(sb, fullSteps);
    },
  };
  vm.createContext(sb);
  const code = [
    extractFn('lsGdiGray'),
    extractFn('lsWaitQuiet'),
    extractFn('lsWaitMotion'),
    extractFn('lsAutoStepLoop'),
    'this.lsAutoStepLoop = lsAutoStepLoop;',
  ].join('\n');
  vm.runInContext(code, sb);

  // 运行：先起循环（同步跑到第一个 await），再起虚拟时钟泵
  const loopP = sb.lsAutoStepLoop(1).then(() => pumpDone);
  setImmediate(pump);
  await Promise.race([
    loopP,
    new Promise((_, rej) => setTimeout(() => rej(new Error('scenario timeout (loop stuck)')), 10000)),
  ]);
  return { name, log, stepCalls, fullSteps, finished, toasts, sb };
}

(async () => {
  let pass = 0, fail = 0;
  const assert = (cond, msg) => { if (cond) { pass++; console.log(`  ok ${msg}`); } else { fail++; console.error(`  FAIL ${msg}`); } };

  // 场景1 正常步进：每格 = 基线1拍 + 运动 → 静止；第2格后结束会话
  console.log('场景1 正常步进');
  {
    let phase = 0, lastStepSeen = 0;
    const r = await runScenario('normal', ({ stepCalls }) => {
      if (stepCalls !== lastStepSeen) { lastStepSeen = stepCalls; phase = 0; }
      phase++;
      return gdiFrame(phase === 1 ? 10 : 80); // 每格第 1 拍基线、第 2 拍起为新画面（运动→静止）
    }, {
      onFullStep: (sb, n) => {
        sb.lsLastStepAppended = true; sb.lsLastGoodS = 260;
        if (n >= 2) sb.longShotActive = false;
      },
    });
    assert(r.stepCalls === 2, `发轮 2 次（实际 ${r.stepCalls}）`);
    assert(r.fullSteps === 2, `抓帧 2 次（实际 ${r.fullSteps}）`);
    assert(!r.finished, '未误触发自动收尾');
    assert(!r.log.some((l) => l.includes('resend')), '无补发');
    if (r.fullSteps !== 2 || r.finished) console.log('  [log]', r.log.join(' | '));
  }

  // 场景2 滚轮被吞：首格画面 9 拍窗口纹丝不动 → 补发后 ~2 拍开始滚动 → 恢复抓帧；随后结束
  console.log('场景2 滚轮被吞 → 补发恢复');
  {
    let postResend = 0;
    const r = await runScenario('eaten', ({ stepCalls }) => {
      if (stepCalls < 2) return gdiFrame(10);      // 首格：原始滚轮被吞，画面全静（覆盖 9 拍窗口）
      postResend++;
      return gdiFrame(postResend <= 2 ? 10 : 80);  // 补发后 ~2 拍开始滚动（动画落在补发等待窗内）
    }, {
      onFullStep: (sb, n) => { sb.lsLastStepAppended = true; sb.lsLastGoodS = 260; if (n >= 1) sb.longShotActive = false; },
    });
    assert(r.stepCalls === 2, `发轮 2 次（1 原始 + 1 补发，实际 ${r.stepCalls}）`);
    assert(r.log.some((l) => l.includes('resend once')), '日志含补发');
    assert(r.fullSteps === 1, `补发后抓帧 1 次（实际 ${r.fullSteps}）`);
    assert(!r.finished, '未误触发自动收尾');
    if (r.fullSteps !== 1 || r.finished) console.log('  [log]', r.log.join(' | '));
  }

  // 场景3 页面到底：画面永远不动 → 补发仍不动 → 自动收尾（等效 Enter）
  console.log('场景3 页面到底 → 自动收尾');
  {
    const r = await runScenario('bottom', () => gdiFrame(10));
    assert(r.stepCalls === 2, `发轮 2 次（原始+补发，实际 ${r.stepCalls}）`);
    assert(r.finished, '自动收尾被调用');
    assert(r.toasts.length === 1 && r.toasts[0].includes('未滚动'), `零拼接收尾须提示原因（实际 ${JSON.stringify(r.toasts)}）`);
    assert(r.fullSteps === 0, '未抓静帧（旧流程此处会空转）');
    assert(r.log.some((l) => l.includes('wheel dead')), '日志含到底判定');
    if (!r.finished) console.log('  [log]', r.log.join(' | '));
  }

  // 场景4 吸附式页面（r57）：实测位移持续 ~120 << 目标 262 → 进入吸附模式，
  // 每步连发 3 个滚轮跨卡点；随后按实测/目标自适应增减
  console.log('场景4 吸附式页面 → 多滚轮补偿');
  {
    let lastSeen = -1, postResend = 0;
    const gdi = ({ stepCalls }) => {
      if (stepCalls !== lastSeen) { lastSeen = stepCalls; postResend = 0; }
      postResend++;
      return gdiFrame(postResend === 1 ? 10 : 80); // 每次滚轮后画面都有变化（卡点小步）
    };
    const r = await runScenario('snap', gdi, {
      onFullStep: (sb2) => {
        sb2.lsLastStepAppended = true;
        sb2.lsLastGoodS = 50; // 每步只走 50px（页面按卡点固定小步，与滚轮量无关）
        sb2.lsAcceptCount = (sb2.lsAcceptCount || 0) + 1;
        if (sb2.lsAutoSnapMode) sb2.__snaps = (sb2.__snaps || 0) + 1;
        if (sb2.lsAcceptCount >= 8) sb2.longShotActive = false; // 4 格后结束
      },
    });
    const wheelsPerStep = r.stepCalls - r.fullSteps; // 总发轮 - 格数 = 吸附模式多发的轮次
    assert(r.log.some((l) => l.includes('snap scroll detected')), '检测到吸附式滚动');
    assert((r.sb.__snaps || 0) >= 1, '进入吸附模式');
    assert(wheelsPerStep >= 6, `吸附后每步多发滚轮（发轮 ${r.stepCalls} - 格数 ${r.fullSteps} = 多发 ${wheelsPerStep}）`);
    assert(!r.finished, '未误触发自动收尾');
    if (!(wheelsPerStep >= 6)) console.log('  [log]', r.log.join(' | '));
  }

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
