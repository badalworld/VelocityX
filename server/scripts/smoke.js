// Smoke test: verify EMA/ATR ports + signal logic + qty split against reference values.
const { ema, atr, signalAt, computeSnapshot } = require('../dist/indicators');
const { splitQty } = require('../dist/trader');

let failures = 0;
function approx(a, b, tol, name) {
  const ok = Math.abs(a - b) <= tol;
  if (!ok) { failures++; console.log(`FAIL ${name}: got ${a}, expected ${b}`); }
  else console.log(`ok   ${name} = ${a}`);
}

// ---- EMA: reference values computed by pandas ewm(alpha=2/12, adjust=False) seeded with SMA ----
// We precompute reference in python and paste below (see /tmp/gen_ref.py output).
const closes = require('/tmp/ref_closes.json');
const refEma11 = require('/tmp/ref_ema11.json');
const refAtr14 = require('/tmp/ref_atr14.json');

const e11 = ema(closes, 11);
for (const i of [10, 50, 99, 199]) {
  approx(e11[i], refEma11[i], 1e-6, `ema11[${i}]`);
}
const candles = closes.map((c, i) => ({
  time: i, closeTime: i, close: c,
  open: c, high: c + 5 + (i % 7), low: c - 4 - (i % 5), volume: 1,
}));
const a14 = atr(candles, 14);
for (const i of [13, 50, 99, 199]) {
  approx(a14[i], refAtr14[i], 1e-6, `atr14[${i}]`);
}

// ---- signal: craft cross up at index 100 ----
const f = [], s = [];
for (let i = 0; i < 120; i++) {
  if (i < 100) { f.push(100); s.push(100); }        // flat: no cross
  else if (i === 100) { f.push(101); s.push(100); } // cross happens AT 100
  else { f.push(102); s.push(100); }
}
// signalAt checks i-1 vs i-2 => at i=101: f[100]>s[100] && f[99]<=s[99] => LONG
console.assert(signalAt(f, s, 100) === null, 'no signal at cross bar itself (confirmed logic)');
console.assert(signalAt(f, s, 101) === 'LONG', 'LONG at 101');
console.assert(signalAt(f, s, 102) === null, 'no repeat at 102');
// cross down
const f2 = f.slice(), s2 = s.slice();
f2[110] = 99; s2[110] = 100; // cross down occurs at 110 (prev f=102>s=100)
// at i=111: f[110]<s[110] && f[109]>=s[109] => SHORT
console.assert(signalAt(f2, s2, 111) === 'SHORT', 'SHORT at 111');
console.assert(signalAt(f2, s2, 110) === null, 'no signal at down-cross bar');
console.log('ok   signal detection logic');

// ---- splitQty: 33% / 50%-of-remaining / rest ----
const cases = [
  [1.000, 0.001], // 1000 steps
  [0.008, 0.001], // 8 steps
  [0.003, 0.001], // 3 steps (minimum ladder)
  [0.004, 0.001],
  [5000, 1],      // DOGE-like
  [12345, 1],
];
for (const [q, step] of cases) {
  const { q1, q2, q3 } = splitQty(q, step, 33, 50);
  const sum = Number((q1 + q2 + q3).toFixed(8));
  const okSum = Math.abs(sum - q) < 1e-7;
  const okMin = q < 3 * step ? (q1 === 0 && q3 === q) : (q1 >= step && q2 >= step && q3 >= step);
  if (!okSum || !okMin) { failures++; console.log(`FAIL splitQty(${q},${step}): ${q1}/${q2}/${q3}`); }
  else console.log(`ok   splitQty(${q}, ${step}) = ${q1}/${q2}/${q3} (${((q1/q)*100).toFixed(0)}/${((q2/q)*100).toFixed(0)}/${((q3/q)*100).toFixed(0)}%)`);
}

// snapshot wiring
const snap = computeSnapshot(candles, [5,11,15,18,21,24,28,34], 200, 14);
console.assert(snap.emas.length === 8 && snap.emas[1].length === candles.length, 'snapshot shape');
console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
