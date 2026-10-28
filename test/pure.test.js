const assert = require('assert');
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'aptem-otj-autofill.user.js'), 'utf8');
const m = { exports: {} };
new Function('module', 'window', src)(m, undefined);
const P = m.exports;

assert.deepStrictEqual(P.parseTimeRange('09:00-09:45'), { start: 540, end: 585 });
assert.deepStrictEqual(P.parseTimeRange(' 14:00 – 15:45 '), { start: 840, end: 945 });
assert.strictEqual(P.parseTimeRange('Lunch'), null);
assert.strictEqual(P.parseTimeRange('12:00-11:00'), null);

assert.strictEqual(P.parseDayHeading('Monday 28th September 2026'), '2026-09-28');
assert.strictEqual(P.parseDayHeading('Tuesday 29th September 2026'), '2026-09-29');
assert.strictEqual(P.parseDayHeading('Friday 2nd October 2026'), '2026-10-02');
assert.strictEqual(P.parseDayHeading('WEEKLY THEME: Motor Systems 1'), null);

assert.strictEqual(P.fmtHM(2250), '37:30');
assert.strictEqual(P.parseHM('37:30'), 2250);
assert.strictEqual(P.parseHM('37.5'), 2250);
assert.strictEqual(P.shortDay('2026-09-28'), 'Mon 28/09');
assert.strictEqual(P.shortDay('2026-10-02'), 'Fri 02/10');

for (const [list, target] of [
  [[{ topic: 'A', minutes: 120 }, { topic: 'B', minutes: 90 }, { topic: 'C', minutes: 37 }], 900],
  [[{ topic: 'A' }, { topic: 'B' }, { topic: 'C' }], 600],
  [[{ title: 'A', minutes: 60 }], 135],
  [[{ topic: 'A', minutes: 600 }, { topic: 'B', minutes: 600 }], 30],
]) {
  const out = P.normaliseTopics(list, target);
  assert.strictEqual(out.reduce((a, x) => a + x.minutes, 0), target, JSON.stringify(out));
  assert.ok(out.every((x) => x.minutes > 0));
}
assert.deepStrictEqual(P.normaliseTopics([], 300), []);

const t = [{ topic: 'Corticospinal tract', minutes: 90 }, { topic: 'Cerebellar signs', minutes: 120 }];
assert.deepStrictEqual(P.textToTopics(P.topicsToText(t)), t);

assert.strictEqual(P.bestOption(['None', 'This work was completed during paid working hours', 'Paid - in my own time'], 'paid in my own time'), 2);
assert.strictEqual(P.bestOption(['Select…', 'Evidence', 'Other'], 'Other'), 2);

const week = { title: 'NEUROLOGY: TIMETABLE WK 4 (28.09.26 - 02.10.26)', theme: ['Motor Systems 1', 'Motor systems 2'] };
const sessions = [
  { date: '2026-09-28', start: 540, end: 585, title: 'Neurophobia podcast', delivery: '' },
  { date: '2026-09-29', start: 540, end: 585, title: 'Cranial Infections', delivery: 'Face to Face (Que101)' },
];
const note = P.buildNote(week, sessions, P.normaliseTopics(t, 2160), 2250);
console.log(note);
assert.ok(note.includes('Total: 37:30'));
console.log('\nall tests passed');
