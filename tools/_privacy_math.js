// 隐私打码 / 去换行 的纯算法回归（2026-11-25）
// 做法与 _trim_math.js / _dedup_math.js 一致：**直接从 capture.js 抽取真实源码**在 node 里跑，
// 不复制一份实现——否则测试绿了而线上代码是另一套，等于没测。
// 运行：node tools/_privacy_math.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'resources', 'capture.js'), 'utf8');
const lines = src.split(/\r?\n/);

/** 顶层函数：从 `function NAME(` 行取到下一个行首 `}`（capture.js 的顶层函数都是这个风格） */
function extractFn(name) {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`未找到函数 ${name}`);
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`函数 ${name} 没有行首结束括号`);
}

/** 顶层数组常量：从 `const NAME = [` 取到行首 `];` */
function extractConstArray(name) {
  const start = lines.findIndex((l) => l.startsWith(`const ${name} = [`));
  if (start < 0) throw new Error(`未找到常量 ${name}`);
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '];') return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`常量 ${name} 没有行首结束括号`);
}

const code = [
  extractConstArray('PRIVACY_RULES'),
  extractFn('unwrapOcrText'),
  extractFn('privacyCharWeight'),
  extractFn('privacySubRect'),
  extractFn('scanPrivacy'),
].join('\n\n');

const ctx = vm.createContext({});
vm.runInContext(code + '\n;globalThis.__api = { unwrapOcrText, privacySubRect, scanPrivacy };', ctx);
const { unwrapOcrText, privacySubRect, scanPrivacy } = ctx.__api;

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('— 去换行 —');
ok('中文段内换行直接相接', unwrapOcrText('深度学习近年来\n发展迅速') === '深度学习近年来发展迅速');
ok('英文段内换行补一个空格', unwrapOcrText('the rapid progress\nof on-device') === 'the rapid progress of on-device');
ok('空行分段保留', unwrapOcrText('第一段\n继续\n\n第二段') === '第一段继续\n\n第二段');
ok('中英混排边界补空格', unwrapOcrText('使用 Transformer\n模型') === '使用 Transformer 模型');
ok('空输入不炸', unwrapOcrText('') === '' && unwrapOcrText(null) === '');

console.log('— 隐私命中 —');
const line = (text, box) => ({ text, box: box || [0, 0, 400, 20] });
const hitLabels = (ls) => scanPrivacy(ls).map((h) => h.label);
ok('手机号', hitLabels([line('联系电话 13812345678 谢谢')]).includes('手机号'));
ok('邮箱', hitLabels([line('mail: zhang.san@example.com.cn')]).includes('邮箱'));
ok('身份证优先于银行卡（18 位不被 16~19 位规则重复命中）',
  JSON.stringify(hitLabels([line('身份证 11010519491231002X')])) === JSON.stringify(['身份证']));
ok('16 位卡号识别为银行卡', hitLabels([line('卡号 6222021234567890')]).includes('银行卡'));
ok('QQ 只框号码本身', (() => {
  const hits = scanPrivacy([line('QQ：123456789')]);
  return hits.length === 1 && hits[0].label === 'QQ';
})());
ok('微信号', hitLabels([line('微信：abc_def123')]).includes('微信'));
ok('非手机号 11 位数字不误报', hitLabels([line('订单号 12345678901')]).length === 0);
ok('普通文本零命中', hitLabels([line('今天天气不错，我们去公园散步')]).length === 0);
ok('同一行多处命中各自成块', scanPrivacy([line('13800000000 和 a@b.com')]).length === 2);

console.log('— 子矩形定位 —');
const box = [100, 50, 500, 70]; // x1,y1,x2,y2，宽 400
const text = '电话13812345678结束';
const idx = text.indexOf('13812345678');
const r = privacySubRect({ text, box }, idx, idx + 11);
ok('子矩形落在行框纵向范围内', r[1] === 50 && r[3] === 70);
ok('子矩形横向不越界（含 0.6 字符余量）', r[0] >= 100 - 30 && r[2] <= 500 + 30, JSON.stringify(r));
ok('命中在行首 → 子矩形靠左', r[0] < 200, JSON.stringify(r));
const tail = '前面的文字很长很长很长13812345678';
const ti = tail.indexOf('13812345678');
const r2 = privacySubRect({ text: tail, box }, ti, ti + 11);
ok('命中在行尾 → 子矩形明显右移', r2[0] > r[0] + 100, `${r[0]} vs ${r2[0]}`);
ok('子矩形有最小宽度（不会退化成 0）', r[2] - r[0] >= 2 && r2[2] - r2[0] >= 2);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
