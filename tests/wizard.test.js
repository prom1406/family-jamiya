/* اختبارات منطق معالج الإنشاء (الحسابات والتحقق).
   التشغيل:  node --test tests/
   تُحمَّل دوال الدورات الحقيقية من index.html (FREQS/periodStart/dayIn/...) فتُختبر القواعد الفعلية لا نسخة منها. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const a = html.indexOf('const FREQS = {'), b = html.indexOf('const r2 = n =>');
assert.ok(a > 0 && b > a, 'تعذر استخراج منطق الدورات من index.html');
const cycleSrc = html.slice(a, html.indexOf('\n', b));

const ctx = vm.createContext({
  module: { exports: {} }, console,
  LOCD: () => 'ar-SA-u-ca-gregory-nu-latn', fmtMonth: d => d.toISOString().slice(0, 7), fmtDate: d => d.toISOString().slice(0, 10)
});
vm.runInContext(cycleSrc, ctx);
// دوال الجوال والآيبان الحقيقية من التطبيق (لا بدائل مبسّطة)
const pa = html.indexOf('const fixIban ='), pb = html.indexOf('const validPhone =');
assert.ok(pa > 0 && pb > pa, 'تعذر استخراج دوال الجوال/الآيبان من index.html');
vm.runInContext(html.slice(pa, html.indexOf('\n', pb)), ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'wizard.js'), 'utf8'), ctx);
const W = ctx.module.exports;
const TODAY = '2026-10-18', ENV = { today: TODAY, now: new Date('2026-10-18T12:00:00'), myPhone: '0500000000' };
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

test('الأرقام: عربية وفارسية وفواصل', () => {
  assert.equal(W.wzNum('٥٠٠'), 500);
  assert.equal(W.wzNum('۱۲۳'), 123);
  assert.equal(W.wzNum('1,500'), 1500);      // فاصل آلاف
  assert.equal(W.wzNum('٢٫٥'), 2.5);          // فاصلة عشرية عربية
  assert.equal(W.wzNum('1,5'), 1.5);          // فاصلة عشرية أوروبية
  assert.equal(W.wzNum('1,234,567.5'), 1234567.5);
  assert.ok(Number.isNaN(W.wzNum('')));
  assert.ok(Number.isNaN(W.wzNum('12abc')));
  assert.ok(Number.isNaN(W.wzNum('-5')));
  assert.ok(Number.isNaN(W.wzNum('1e3')));
  assert.equal(W.wzInt('12'), 12);
  assert.ok(Number.isNaN(W.wzInt('12.5')));
});

test('التواريخ: صحة وتقويم', () => {
  assert.ok(W.wzIsDate('2026-02-28'));
  assert.ok(!W.wzIsDate('2026-02-30'));
  assert.ok(!W.wzIsDate('26-1-1'));
  assert.equal(W.wzDaysBetween('2026-10-18', '2026-10-25'), 7);
});

test('جمعية شهرية: الإجماليات والمدة والجدول وفق قواعد النظام', () => {
  const v = W.wzParse('jamiya', { jname: 'جمعية العائلة', count: '10', amount: '500', frequency: 'monthly', start: '2026-11-01', lastDay: '25', payDay: '27' }, ENV);
  const val = W.wzValidate('jamiya', v, ENV);
  assert.equal(val.ok, true);
  const p = W.wzPlanJamiya(v, ENV);
  assert.equal(p.ready, true);
  assert.equal(p.members, 10); assert.equal(p.perCycle, 500);
  assert.equal(p.pot, 5000);       // count × amount (إجمالي الدورة كما في صفحة الجمعية)
  assert.equal(p.total, 50000);    // count × count × amount
  assert.equal(iso(p.first), '2026-11-01');
  assert.equal(iso(p.last), '2027-08-31');
  assert.equal(p.schedule.length, 10);
  assert.equal(iso(p.schedule[0].due), '2026-11-25');
  assert.equal(iso(p.schedule[0].payout), '2026-11-27');
  assert.equal(iso(p.schedule[9].from), '2027-08-01');
});

test('جمعية شهرية تبدأ من أول الشهر حتى لو كان تاريخ البداية في منتصفه', () => {
  const v = W.wzParse('jamiya', { jname: 'x', count: '3', amount: '100', frequency: 'monthly', start: '2026-11-15', lastDay: '25', payDay: '27' }, ENV);
  const p = W.wzPlanJamiya(v, ENV);
  assert.equal(iso(p.first), '2026-11-01');
  assert.ok(W.wzValidate('jamiya', v, ENV).warnings.some(t => t.includes('أول الشهر')));
});

test('جمعية أسبوعية: المدة بالأيام وحدود الأيام 1..7', () => {
  const v = W.wzParse('jamiya', { jname: 'x', count: '10', amount: '50', frequency: 'weekly', start: '2026-11-01', lastDay: '5', payDay: '7' }, ENV);
  const p = W.wzPlanJamiya(v, ENV);
  assert.equal(p.spanDays, 70);
  assert.equal(iso(p.last), '2027-01-09');
  assert.equal(iso(p.schedule[1].from), '2026-11-08');
  assert.equal(iso(p.schedule[0].payout), '2026-11-07');
  const bad = W.wzParse('jamiya', { jname: 'x', count: '10', amount: '50', frequency: 'weekly', start: '2026-11-01', lastDay: '9', payDay: '7' }, ENV);
  const r = W.wzValidate('jamiya', bad, ENV);
  assert.ok(r.errors.lastDay && !r.errors.payDay);
});

test('لا تُعرض نتائج مضللة عند نقص البيانات', () => {
  const v = W.wzParse('jamiya', { jname: '', count: '', amount: '500', frequency: 'monthly', start: '', lastDay: '', payDay: '' }, ENV);
  const p = W.wzPlanJamiya(v, ENV);
  assert.equal(p.ready, false);
  assert.equal(p.pot, null); assert.equal(p.total, null);
  assert.equal(p.first, null); assert.equal(p.schedule, null);
  assert.equal(p.perCycle, 500);
  const r = W.wzValidate('jamiya', v, ENV);
  assert.ok(r.errors.jname && r.errors.count && r.errors.start && r.errors.lastDay && r.errors.payDay);
});

test('حدود عدد الأعضاء والقسط', () => {
  const mk = (count, amount) => W.wzValidate('jamiya', W.wzParse('jamiya', { jname: 'x', count, amount, frequency: 'monthly', start: '2026-11-01', lastDay: '25', payDay: '27' }, ENV), ENV).errors;
  assert.ok(mk('1', '100').count); assert.ok(mk('31', '100').count);
  assert.ok(!mk('2', '100').count); assert.ok(!mk('30', '100').count);
  assert.ok(mk('5', '0').amount); assert.ok(mk('5', '0.5').amount); assert.ok(!mk('5', '1').amount);
  assert.ok(mk('5.5', '100').count);
});

test('تنبيهات الجمعية: بداية في الماضي ويوم استلام قبل آخر سداد', () => {
  const v = W.wzParse('jamiya', { jname: 'x', count: '5', amount: '100', frequency: 'monthly', start: '2026-09-01', lastDay: '27', payDay: '20' }, ENV);
  const r = W.wzValidate('jamiya', v, ENV);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some(t => t.includes('الماضي')));
  assert.ok(r.warnings.some(t => t.includes('يسبق')));
});

test('القطة: حصة الفرد والتقريب والمدد', () => {
  const v = W.wzParse('qattah', { qname: 'رحلة', qreason: 'سبب', qtarget: '1000', qpart: '3', qcs: '2026-10-18', qce: '2026-11-17', qes: '2026-11-20', qee: '2026-11-22' }, ENV);
  assert.equal(W.wzValidate('qattah', v, ENV).ok, true);
  const p = W.wzPlanQattah(v, ENV);
  assert.equal(p.share, 333.33);
  assert.equal(p.expected, 999.99);
  assert.equal(p.rounding, 0.01);
  assert.equal(p.remaining, 1000);
  assert.equal(p.collectDays, 31);
  assert.equal(p.daysToEvent, 33);
  assert.equal(p.eventDays, 3);
  const even = W.wzPlanQattah(W.wzParse('qattah', { qtarget: '1000', qpart: '4' }, ENV), ENV);
  assert.equal(even.share, 250); assert.equal(even.rounding, 0);
});

test('القطة: قواعد التواريخ كما في qtReadForm', () => {
  const base = { qname: 'a', qreason: 'b', qtarget: '100', qpart: '2', qcs: '2026-10-18', qce: '2026-11-17', qes: '2026-11-20', qee: '2026-11-22' };
  const run = o => W.wzValidate('qattah', W.wzParse('qattah', { ...base, ...o }, ENV), ENV).errors;
  assert.ok(run({ qce: '2026-10-10' }).qce);                         // نهاية الجمع قبل بدايته
  assert.ok(run({ qes: '2026-10-10' }).qes);                         // الفعالية تسبق بداية الجمع
  assert.ok(run({ qee: '2026-11-19' }).qee);                         // نهاية الفعالية قبل بدايتها
  assert.ok(run({ qcs: '2026-09-01', qce: '2026-10-01', qes: '2026-10-02', qee: '2026-10-03' }).qce); // ماضٍ
  assert.deepEqual({ ...run({}) }, {});
  assert.ok(run({ qpart: '101' }).qpart);
});

test('تعاون عائلي (فترة واحدة): الهدف والتقدير', () => {
  const v = W.wzParse('family', { jname: 'ن', goal: 'ه', reasons: 'س', mode: 'once', target: '3000', endDate: '2026-11-18', bank: 'مصرف الراجحي', iban: 'SA03 8000 0000 6080 1016 7519', fpart: '8' }, ENV);
  assert.equal(W.wzValidate('family', v, ENV).ok, true);
  const p = W.wzPlanFamily(v, ENV);
  assert.equal(p.daysLeft, 31);
  assert.equal(p.share, 375); assert.equal(p.expected, 3000); assert.equal(p.remaining, 3000);
  const noPart = W.wzPlanFamily({ ...v, participants: null }, ENV);
  assert.equal(noPart.share, null);       // لا حصة تقديرية بلا عدد مشاركين
});

test('تعاون عائلي: الآيبان والتاريخ والهدف', () => {
  const base = { jname: 'ن', goal: 'ه', reasons: 'س', mode: 'once', target: '', endDate: '2026-11-18', bank: 'مصرف الراجحي', iban: 'SA0380000000608010167519' };
  const run = o => W.wzValidate('family', W.wzParse('family', { ...base, ...o }, ENV), ENV);
  assert.equal(run({}).ok, true);
  assert.ok(run({}).warnings.some(t => t.includes('شريط تقدم')));
  assert.ok(run({ iban: 'SA123' }).errors.iban);
  assert.ok(run({ endDate: '2026-10-01' }).errors.endDate);
  assert.ok(run({ endDate: '' }).errors.endDate);
  assert.ok(run({ target: '0' }).errors.target);
  assert.ok(run({ bank: 'بنك رقمي / أخرى', bankOther: 'x' }).errors.bankOther);
  assert.ok(run({ fpart: '1' }).errors.fpart);
});

test('تعاون عائلي شهري: عدد الأشهر التقديري', () => {
  const v = W.wzParse('family', { jname: 'ن', goal: 'ه', reasons: 'س', mode: 'monthly', targetM: '10000', monthlyDay: '1', monthlyAmount: '300', fpart: '8', bank: 'مصرف الراجحي', iban: 'SA0380000000608010167519' }, ENV);
  assert.equal(W.wzValidate('family', v, ENV).ok, true);
  const p = W.wzPlanFamily(v, ENV);
  assert.equal(p.perCycle, 2400);
  assert.equal(p.months, 5);               // ceil(10000/2400)
  assert.equal(iso(p.finish), '2027-02-01');
  const bad = W.wzValidate('family', W.wzParse('family', { jname: 'ن', goal: 'ه', reasons: 'س', mode: 'monthly', targetM: '', monthlyDay: '29', monthlyAmount: '0', bank: 'x', iban: 'SA0380000000608010167519' }, ENV), ENV).errors;
  assert.ok(bad.targetM && bad.monthlyDay && bad.monthlyAmount);
});

test('الدين: الحالة حسب التواريخ والرصيد', () => {
  const mk = o => W.wzPlanDebt(W.wzParse('debt', { kind: 'lent', cname: 'خالد', amount: '1000', start: '2026-10-01', due: '', ...o }, ENV), ENV);
  assert.equal(mk({}).status, 'open');
  assert.equal(mk({ due: '2026-10-22' }).status, 'soon');
  assert.equal(mk({ due: '2026-10-25' }).status, 'soon');   // 7 أيام
  assert.equal(mk({ due: '2026-10-26' }).status, 'open');
  assert.equal(mk({ due: '2026-10-10' }).status, 'late');
  const p = mk({ amount: '1,250.5' });
  assert.equal(p.principal, 1250.5); assert.equal(p.paid, 0); assert.equal(p.remaining, 1250.5);
  assert.equal(mk({ amount: '' }).ready, false);
  assert.equal(mk({ amount: '' }).remaining, null);
});

test('الدين: قواعد التحقق (الجوال، الاستلاف، النفس، التواريخ)', () => {
  const base = { kind: 'lent', cname: 'خالد', cphone: '', amount: '100', start: '2026-10-01', due: '' };
  const run = o => W.wzValidate('debt', W.wzParse('debt', { ...base, ...o }, ENV), ENV);
  assert.equal(run({}).ok, true);
  assert.ok(run({ cname: 'خ' }).errors.cname);
  assert.ok(run({ cphone: '0123' }).errors.cphone);
  assert.equal(run({ cphone: '٠٥٥٥٥٥٥٥٥٥' }).ok, true);          // أرقام عربية
  assert.ok(run({ kind: 'loan' }).errors.cphone);                  // الاستلاف يتطلب جوالاً
  assert.equal(run({ kind: 'loan', cphone: '0555555555' }).ok, true);
  assert.ok(run({ cphone: '0500000000' }).errors.cphone);          // نفسه
  assert.ok(run({ amount: '0' }).errors.amount);
  assert.ok(run({ due: '2026-09-01' }).errors.due);                // قبل تاريخ الدين
  assert.ok(run({ start: '2026-08-01', due: '2026-09-01' }).warnings.some(t => t.includes('متأخراً')));
});

test('الافتراضات الذكية', () => {
  assert.deepEqual({ ...W.wzDayDefaults('monthly') }, { lastDay: 25, payDay: 27 });
  assert.deepEqual({ ...W.wzDayDefaults('weekly') }, { lastDay: 5, payDay: 7 });
  assert.deepEqual({ ...W.wzDayDefaults('biweekly') }, { lastDay: 12, payDay: 14 });
  assert.deepEqual({ ...W.wzDayDefaults('tenday') }, { lastDay: 8, payDay: 10 });
  assert.equal(W.wzDefaultStart('monthly', '2026-10-18'), '2026-11-01');
  assert.equal(W.wzDefaultStart('monthly', '2026-12-18'), '2027-01-01');
  assert.equal(W.wzDefaultStart('weekly', '2026-10-18'), '2026-10-18');
});

test('اقتراح الاسم والمسودة', () => {
  const n = W.wzSuggestName('jamiya', { frequency: 'monthly', now: new Date('2026-10-18T12:00:00') });
  assert.ok(n.startsWith('جمعية شهرية') && n.endsWith('2026'));
  assert.ok(W.wzSuggestName('qattah', { now: new Date('2026-10-18T12:00:00') }).startsWith('قطة'));
  assert.ok(W.wzSuggestName('jamiya', { frequency: 'weekly', lang: 'en', now: new Date('2026-10-18T12:00:00') }).startsWith('Weekly association'));
  assert.equal(W.wzHasContent('jamiya', { jname: '', count: '', amount: '', start: '2026-11-01' }), false);   // القيم الافتراضية لا تُعد مسودة
  assert.equal(W.wzHasContent('jamiya', { jname: 'جمعية' }), true);
  assert.equal(W.wzHasContent('debt', { amount: ' ' }), false);
  assert.ok(W.WZ_NO_DRAFT.includes('iban') && W.WZ_NO_DRAFT.includes('cphone'));
});
