/* ============================================================================
   معالج الإنشاء في سِواء:  النوع ← البيانات ← المعاينة ← التأكيد
   ----------------------------------------------------------------------------
   • يغلّف نماذج الإنشاء الحالية (جمعية f-create، تعاون f-create-family،
     قطّة f-qat-create، دين f-db-new) دون تغيير منطق الحفظ: الحفظ يتم عبر
     نفس المعالجات الموجودة (handleCreate / handleCreateFamily / qtCreate / dbCreate).
   • القسم 1 منطق صافٍ (حسابات + تحقق) بلا اعتماد على DOM، وتُختبر دوالّه
     بـ  node --test tests/wizard.test.js
   • القسم 2 واجهة المعالج (عرض، تنقل، مسودة، تحقق فوري).
   ملاحظة: يُحمَّل قبل السكربت الرئيسي، لذا لا يستدعي أي دالة من التطبيق عند التحميل.
   ============================================================================ */

/* ============================== 1) منطق صافٍ ============================== */
const WZ_TYPES = {
  jamiya: { icon: 'fa-people-roof', title: 'جمعية دورية', sub: 'مساهمات منتظمة بين مجموعة من الأعضاء بالتناوب', formId: 'f-create', done: 'الجمعية' },
  family: { icon: 'fa-handshake', title: 'تعاون عائلي', sub: 'مساهمات من عدة أشخاص لدعم هدف مشترك', formId: 'f-create-family', done: 'التعاون' },
  qattah: { icon: 'fa-hand-holding-dollar', title: 'قِطّة مشتركة', sub: 'صندوق مشترك لرحلة أو مناسبة مع متابعة المصروفات', formId: 'f-qat-create', done: 'القطة' },
  debt: { icon: 'fa-scale-balanced', title: 'تسجيل دين', sub: 'ما لك أو عليك: الطرف الآخر والمبلغ وموعد السداد', formId: 'f-db-new', done: 'الدين' }
};
const WZ_STEP_NAMES = ['النوع', 'البيانات', 'المعاينة', 'التأكيد'];
const WZ_DAY_MS = 86400000;

// أرقام عربية/فارسية → لاتينية، وفاصلة عشرية عربية → نقطة (آمن أثناء الكتابة)
function wzDigits(s) {
  return String(s == null ? '' : s)
    .replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)))
    .replace(/[۰-۹]/g, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)))
    .replace(/٫/g, '.').replace(/[٬\s‎‏ ]/g, '');
}
// عند التحليل فقط: الفاصلة قد تكون فاصل آلاف (1,500) أو عشرية (1,5)
function wzNormNumber(s) {
  let t = wzDigits(s).replace(/،/g, ',');
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
  else if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.');
  return t;
}
function wzNum(s) { const t = wzNormNumber(s); return /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN; }
function wzInt(s) { const n = wzNum(s); return Number.isInteger(n) ? n : NaN; }
function wzIsDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(s + 'T12:00:00'); return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
const wzDaysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / WZ_DAY_MS);
const wzIso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const wzR2 = n => Math.round(n * 100) / 100;

// بيئة التشغيل: كل ما يحتاجه المنطق من التطبيق (قابلة للاستبدال في الاختبار)
function wzEnv(over) {
  const base = {
    today: typeof isoDay === 'function' ? isoDay(new Date()) : wzIso(new Date()),
    now: new Date(),
    otherBank: typeof OTHER_BANK !== 'undefined' ? OTHER_BANK : 'بنك رقمي / أخرى',
    fixIban: typeof fixIban === 'function' ? fixIban : s => String(s || '').replace(/\s+/g, '').toUpperCase(),
    validIban: typeof validIban === 'function' ? validIban : s => /^SA\d{22}$/.test(String(s || '').replace(/\s+/g, '').toUpperCase()),
    normPhone: typeof normPhone === 'function' ? normPhone : s => String(s || '').replace(/\D/g, ''),
    validPhone: typeof validPhone === 'function' ? validPhone : s => /^05\d{8}$/.test(String(s || '').trim()),
    myPhone: (typeof state !== 'undefined' && state && state.profile && state.profile.phone) || '',
    lang: typeof LANG !== 'undefined' ? LANG : 'ar'
  };
  return Object.assign(base, over || {});
}

// قيم افتراضية معقولة لأيام السداد والاستلام حسب الدورية (قابلة للتعديل دائماً)
function wzDayDefaults(freq) {
  const f = (typeof FREQS !== 'undefined' && FREQS[freq]) || { days: 0 };
  if (!f.days) return { lastDay: 25, payDay: 27 };
  return { lastDay: Math.max(1, f.days - 2), payDay: f.days };
}
// تاريخ بداية مقترح: للشهرية أول الشهر القادم، ولغيرها اليوم
function wzDefaultStart(freq, today) {
  const f = (typeof FREQS !== 'undefined' && FREQS[freq]) || { days: 0 };
  if (f.days) return today;
  const [y, m] = today.split('-').map(Number);
  return wzIso(new Date(y, m, 1));
}
const WZ_FREQ_NAME = { monthly: 'شهرية', weekly: 'أسبوعية', biweekly: 'كل أسبوعين', tenday: 'كل 10 أيام' };
function wzSuggestName(type, ctx) {
  const c = ctx || {}, now = c.now || new Date(), en = c.lang === 'en';
  const mon = now.toLocaleDateString(en ? 'en-GB' : 'ar-SA-u-ca-gregory-nu-latn', { month: 'long' }), yr = now.getFullYear();
  if (type === 'jamiya') {
    const fq = en ? ({ monthly: 'Monthly', weekly: 'Weekly', biweekly: 'Biweekly', tenday: '10-day' })[c.frequency || 'monthly'] : (WZ_FREQ_NAME[c.frequency || 'monthly'] || 'شهرية');
    return en ? `${fq} association ${mon} ${yr}` : `جمعية ${fq} ${mon} ${yr}`;
  }
  if (type === 'family') return en ? `Family cooperation ${mon} ${yr}` : `تعاون عائلي ${mon} ${yr}`;
  if (type === 'qattah') return en ? `Shared pot ${mon} ${yr}` : `قطة ${mon} ${yr}`;
  return '';
}

/* ---- تحويل القيم الخام (نصوص الحقول) إلى قيم مقروءة ---- */
function wzParse(type, raw, env) {
  const E = wzEnv(env), r = raw || {};
  const s = k => String(r[k] == null ? '' : r[k]).trim();
  const n = k => wzNum(r[k]), i = k => wzInt(r[k]);
  const opt = k => s(k) === '' ? null : wzNum(r[k]);
  const optI = k => s(k) === '' ? null : wzInt(r[k]);
  if (type === 'jamiya') {
    const frequency = (typeof FREQS !== 'undefined' && FREQS[r.frequency]) ? r.frequency : 'monthly';
    return { name: s('jname'), icon: s('icon'), frequency, count: i('count'), amount: n('amount'), start: s('start'), lastDay: i('lastDay'), payDay: i('payDay'), joinSelf: r.joinSelf !== false && r.joinSelf !== 'false' };
  }
  if (type === 'family') {
    return { name: s('jname'), icon: s('icon'), goal: s('goal'), reasons: s('reasons'), mode: r.mode === 'monthly' ? 'monthly' : 'once',
      target: opt('target'), endDate: s('endDate'), targetM: n('targetM'), monthlyDay: i('monthlyDay'), monthlyAmount: opt('monthlyAmount'),
      bank: s('bank'), bankOther: s('bankOther'), iban: E.fixIban(s('iban')), participants: optI('fpart') };
  }
  if (type === 'qattah') {
    return { name: s('qname'), reason: s('qreason'), target: n('qtarget'), participants: i('qpart'), collectStart: s('qcs'), collectEnd: s('qce'), eventStart: s('qes'), eventEnd: s('qee') };
  }
  if (type === 'debt') {
    const kind = ['lent', 'borrowed', 'loan'].includes(r.kind) ? r.kind : 'lent';
    return { kind, name: s('cname'), phoneRaw: s('cphone'), amount: n('amount'), reason: s('reason'), start: s('start'), due: s('due') };
  }
  return {};
}

/* ---- التحقق: نفس قواعد المعالجات الحالية، مع رسائل بجوار الحقول ---- */
function wzValidate(type, v, env) {
  const E = wzEnv(env), e = {}, w = [];
  if (type === 'jamiya') {
    if (!v.name) e.jname = 'اكتب اسم الجمعية';
    if (!(v.count >= 2 && v.count <= 30)) e.count = 'عدد الأعضاء بين 2 و30';
    if (!(v.amount >= 1)) e.amount = 'أدخل قيمة القسط (ريال واحد على الأقل)';
    if (!wzIsDate(v.start)) e.start = 'حدد تاريخ البداية';
    const max = (typeof maxDayOf === 'function') ? maxDayOf({ frequency: v.frequency }) : 31;
    if (!(v.lastDay >= 1 && v.lastDay <= max)) e.lastDay = `اليوم يجب أن يكون بين 1 و${max}`;
    if (!(v.payDay >= 1 && v.payDay <= max)) e.payDay = `اليوم يجب أن يكون بين 1 و${max}`;
    if (!e.start && v.start < E.today) w.push('تاريخ البداية في الماضي: ستُعدّ الدورات المنقضية جارية وقد تظهر دفعات متأخرة.');
    if (!e.lastDay && !e.payDay && v.payDay < v.lastDay) w.push('يوم الاستلام يسبق آخر موعد للسداد في الدورة. تأكد أن هذا مقصود.');
    if (!e.start && v.frequency === 'monthly' && v.start.slice(8) !== '01') w.push('الجمعية الشهرية تبدأ دورتها الأولى من أول الشهر الذي يقع فيه تاريخ البداية.');
  } else if (type === 'family') {
    if (!v.name) e.jname = 'اكتب اسم التعاون';
    if (!v.goal) e.goal = 'اكتب هدف التعاون';
    if (!v.reasons) e.reasons = 'اشرح الأسباب والتفاصيل للأعضاء';
    if (v.bank === E.otherBank && v.bankOther.length < 2) e.bankOther = 'اكتب اسم البنك';
    if (!E.validIban(v.iban)) e.iban = 'الآيبان غير صحيح (SA ثم 22 رقماً)';
    if (v.mode === 'monthly') {
      if (!(v.targetM >= 1)) e.targetM = 'حدد المبلغ المستهدف الذي ينتهي به التعاون';
      if (!(v.monthlyDay >= 1 && v.monthlyDay <= 28)) e.monthlyDay = 'يوم السداد من 1 إلى 28';
      if (v.monthlyAmount !== null && !(v.monthlyAmount >= 1)) e.monthlyAmount = 'قيمة الاشتراك الشهري غير صحيحة';
    } else {
      if (!wzIsDate(v.endDate)) e.endDate = 'حدد تاريخ نهاية التعاون';
      else if (v.endDate < E.today) e.endDate = 'تاريخ النهاية يجب ألا يكون في الماضي';
      if (v.target !== null && !(v.target >= 1)) e.target = 'المبلغ المستهدف غير صحيح';
      if (v.target === null) w.push('لم تحدد مبلغاً مستهدفاً، لذلك لن يظهر شريط تقدم نحو الهدف.');
    }
    if (v.participants !== null && !(v.participants >= 2 && v.participants <= 1000)) e.fpart = 'عدد المشاركين بين 2 و1000';
  } else if (type === 'qattah') {
    if (!v.name) e.qname = 'اكتب اسم القطة';
    if (!v.reason) e.qreason = 'اكتب سبب القطة';
    if (!(v.target >= 1)) e.qtarget = 'حدد القيمة المطلوبة بشكل صحيح';
    if (!(v.participants >= 2 && v.participants <= 100)) e.qpart = 'عدد المشاركين بين 2 و100';
    const d = { qcs: v.collectStart, qce: v.collectEnd, qes: v.eventStart, qee: v.eventEnd };
    Object.keys(d).forEach(k => { if (!wzIsDate(d[k])) e[k] = 'حدد التاريخ'; });
    if (!e.qcs && !e.qce && v.collectEnd < v.collectStart) e.qce = 'نهاية الجمع يجب ألا تسبق بدايته';
    if (!e.qcs && !e.qes && v.eventStart < v.collectStart) e.qes = 'بداية الفعالية يجب ألا تسبق بداية الجمع';
    if (!e.qes && !e.qee && v.eventEnd < v.eventStart) e.qee = 'نهاية الفعالية يجب ألا تسبق بدايتها';
    if (!e.qce && v.collectEnd < E.today) e.qce = 'التاريخ يجب ألا يكون في الماضي';
    if (!e.qee && v.eventEnd < E.today) e.qee = 'التاريخ يجب ألا يكون في الماضي';
    if (!e.qce && !e.qes && v.eventStart < v.collectEnd) w.push('الفعالية تبدأ قبل انتهاء موعد الجمع، لذلك ستستمر المساهمات بعد بدايتها.');
  } else if (type === 'debt') {
    const phone = v.phoneRaw ? E.normPhone(v.phoneRaw) : '';
    if (v.name.length < 2) e.cname = 'اكتب اسم الطرف الآخر';
    if (v.phoneRaw && !E.validPhone(phone)) e.cphone = 'الجوال يبدأ بـ 05 ويتكون من 10 أرقام';
    else if (v.kind === 'loan' && !phone) e.cphone = 'أدخل جوال المُقرض ليصله الطلب';
    else if (phone && E.myPhone && phone === E.normPhone(E.myPhone)) e.cphone = 'لا يمكن تسجيل دين على نفسك';
    if (!(v.amount > 0)) e.amount = 'المبلغ غير صحيح';
    if (!wzIsDate(v.start)) e.start = 'حدد تاريخ الدين';
    if (v.due) {
      if (!wzIsDate(v.due)) e.due = 'التاريخ غير صحيح';
      else if (!e.start && v.due < v.start) e.due = 'موعد السداد يجب ألا يسبق تاريخ الدين';
      else if (v.due < E.today) w.push('موعد السداد في الماضي، لذلك سيظهر الدين متأخراً فور تسجيله.');
    }
  }
  return { errors: e, warnings: w, ok: Object.keys(e).length === 0 };
}

/* ---- الحسابات المالية: لا تُعرض نتيجة إن كانت مدخلاتها ناقصة (null) ---- */
function wzPlanJamiya(v, env) {
  const okCount = v.count >= 2 && v.count <= 30, okAmt = v.amount >= 1;
  const frequency = v.frequency || 'monthly', fq = freqOf({ frequency });
  const p = { type: 'jamiya', frequency, freqLabel: fq.label, members: okCount ? v.count : null, perCycle: okAmt ? wzR2(v.amount) : null,
    pot: null, total: null, cycles: okCount ? v.count : null, first: null, last: null, spanDays: null, schedule: null, ready: false };
  if (okCount && okAmt) { p.pot = wzR2(v.count * v.amount); p.total = wzR2(v.count * v.count * v.amount); }
  const j = { startDate: v.start, frequency, count: v.count };
  if (okCount && wzIsDate(v.start)) {
    p.first = periodStart(j, 0); p.last = periodEnd(j, v.count - 1);
    p.spanDays = Math.round((p.last - p.first) / WZ_DAY_MS) + 1;
    const max = maxDayOf(j);
    if (v.lastDay >= 1 && v.lastDay <= max && v.payDay >= 1 && v.payDay <= max) {
      p.schedule = Array.from({ length: v.count }, (_, k) => ({ n: k + 1, from: periodStart(j, k), to: periodEnd(j, k), due: dayIn(j, k, v.lastDay), payout: dayIn(j, k, v.payDay) }));
    }
  }
  p.ready = p.pot !== null && !!p.schedule;
  return p;
}
function wzPlanQattah(v, env) {
  const E = wzEnv(env), okT = v.target >= 1, okP = v.participants >= 2 && v.participants <= 100;
  const p = { type: 'qattah', target: okT ? wzR2(v.target) : null, participants: okP ? v.participants : null, share: null, expected: null, rounding: 0, remaining: null,
    collectDays: null, daysToCollectEnd: null, daysToEvent: null, eventDays: null, ready: false };
  if (okT && okP) { p.share = wzR2(v.target / v.participants); p.expected = wzR2(p.share * v.participants); p.rounding = wzR2(p.target - p.expected); p.remaining = p.target; }
  if (wzIsDate(v.collectStart) && wzIsDate(v.collectEnd) && v.collectEnd >= v.collectStart) { p.collectDays = wzDaysBetween(v.collectStart, v.collectEnd) + 1; p.daysToCollectEnd = wzDaysBetween(E.today, v.collectEnd); }
  if (wzIsDate(v.eventStart)) p.daysToEvent = wzDaysBetween(E.today, v.eventStart);
  if (wzIsDate(v.eventStart) && wzIsDate(v.eventEnd) && v.eventEnd >= v.eventStart) p.eventDays = wzDaysBetween(v.eventStart, v.eventEnd) + 1;
  p.ready = p.share !== null && p.collectDays !== null;
  return p;
}
function wzPlanFamily(v, env) {
  const E = wzEnv(env), part = v.participants >= 2 ? v.participants : null;
  if (v.mode === 'monthly') {
    const okT = v.targetM >= 1, fixed = v.monthlyAmount >= 1 ? wzR2(v.monthlyAmount) : null;
    const p = { type: 'family', mode: 'monthly', target: okT ? wzR2(v.targetM) : null, monthlyAmount: fixed, monthlyDay: v.monthlyDay, participants: part, share: null, perCycle: null, months: null, finish: null, remaining: okT ? wzR2(v.targetM) : null, ready: okT };
    if (okT && part) p.share = wzR2(v.targetM / part);
    if (okT && fixed && part) {
      p.perCycle = wzR2(fixed * part); p.months = Math.ceil(v.targetM / p.perCycle - 1e-9);
      const [y, m] = E.today.split('-').map(Number); p.finish = new Date(y, m - 1 + p.months - 1, 1); // أول شهر يُتوقع فيه بلوغ الهدف إن سدّد الجميع
    }
    return p;
  }
  const hasT = v.target >= 1, okEnd = wzIsDate(v.endDate) && v.endDate >= E.today;
  const p = { type: 'family', mode: 'once', target: hasT ? wzR2(v.target) : null, endDate: okEnd ? v.endDate : null, daysLeft: okEnd ? wzDaysBetween(E.today, v.endDate) : null,
    participants: part, share: null, expected: null, rounding: 0, remaining: hasT ? wzR2(v.target) : null, ready: okEnd };
  if (hasT && part) { p.share = wzR2(v.target / part); p.expected = wzR2(p.share * part); p.rounding = wzR2(p.target - p.expected); }
  return p;
}
function wzPlanDebt(v, env) {
  const E = wzEnv(env), ok = v.amount > 0, hasDue = wzIsDate(v.due), daysToDue = hasDue ? wzDaysBetween(E.today, v.due) : null;
  let status = 'open';
  if (hasDue && v.due < E.today) status = 'late'; else if (hasDue && daysToDue <= 7) status = 'soon';
  return { type: 'debt', kind: v.kind, principal: ok ? wzR2(v.amount) : null, paid: ok ? 0 : null, remaining: ok ? wzR2(v.amount) : null,
    due: hasDue ? v.due : null, daysToDue, status, ready: ok };
}
function wzPlan(type, v, env) {
  return type === 'jamiya' ? wzPlanJamiya(v, env) : type === 'family' ? wzPlanFamily(v, env) : type === 'qattah' ? wzPlanQattah(v, env) : wzPlanDebt(v, env);
}

/* ---- هل في المسودة محتوى كتبه المستخدم فعلاً؟ (القيم الافتراضية وحدها لا تُعد مسودة) ---- */
const WZ_KEY_FIELDS = { jamiya: ['jname', 'count', 'amount'], family: ['jname', 'goal', 'reasons', 'target', 'targetM'], qattah: ['qname', 'qreason', 'qtarget', 'qpart'], debt: ['cname', 'amount', 'reason'] };
function wzHasContent(type, data) { return (WZ_KEY_FIELDS[type] || []).some(k => data && String(data[k] == null ? '' : data[k]).trim() !== ''); }
// حقول لا تُحفظ في المسودة (بيانات حساسة أو تُعبّأ من الملف الشخصي)
const WZ_NO_DRAFT = ['iban', 'bank', 'bankOther', 'cphone', 'file'];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { wzDigits, wzNormNumber, wzNum, wzInt, wzIsDate, wzDaysBetween, wzDayDefaults, wzDefaultStart, wzSuggestName, wzParse, wzValidate,
    wzPlanJamiya, wzPlanQattah, wzPlanFamily, wzPlanDebt, wzPlan, wzHasContent, WZ_TYPES, WZ_NO_DRAFT };
}

/* ============================== 2) واجهة المعالج ============================== */
const wzS = () => state.wz || (state.wz = { step: 1, max: 1, data: { jamiya: {}, family: {}, qattah: {}, debt: {} }, done: null, restored: {}, touched: {} });
const wzRtl = () => document.documentElement.dir !== 'ltr';
const wzMoney = n => (typeof money === 'function' ? money(n) : String(n) + ' ريال');
const wzNf = n => (typeof fmtNum === 'function' ? fmtNum(n) : String(n));
const wzFmtD = d => (typeof fmtDate === 'function' ? fmtDate(d) : d.toDateString());
const wzFmtIso = s => wzIsDate(s) ? wzFmtD(new Date(s + 'T12:00:00')) : '—';
const wzE = s => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s));
const WZ_NUMERIC_DECIMAL = ['amount', 'qtarget', 'target', 'targetM', 'monthlyAmount'];

function wzStart(type) {
  const wz = wzS(); wz.done = null; wz.touched = {};
  if (WZ_TYPES[type]) { state.createType = type; wz.step = 2; wz.max = Math.max(2, wz.max || 1); } else { state.createType = null; wz.step = 1; wz.max = 1; }
  state.view = 'create'; render();
}

/* ---- الإطار العام: الرأس + شريط التقدم + الخطوات ---- */
function wzProgressHtml(step, max) {
  return `<ol class="wz-steps" aria-label="مراحل الإنشاء">${WZ_STEP_NAMES.map((t, i) => {
    const n = i + 1, st = n === step ? 'on' : n < step ? 'done' : '', can = n < step;
    const dot = n < step ? '<i class="fa-solid fa-check"></i>' : n;
    return `<li class="wz-st ${st}" ${n === step ? 'aria-current="step"' : ''}><${can ? `button type="button" data-act="wz-step" data-n="${n}"` : 'span'} class="wz-sb"><span class="wz-dot">${dot}</span><span class="wz-sl">${t}</span></${can ? 'button' : 'span'}></li>`;
  }).join('')}</ol>`;
}
function wzTypeCards(sel) {
  const card = (k, extra) => { const t = WZ_TYPES[k], on = sel === k;
    return `<button type="button" role="radio" aria-checked="${on}" class="wz-card ${extra || ''} ${on ? 'on' : ''}" data-act="wz-type" data-v="${k}">
      <span class="wz-ci"><i class="fa-solid ${t.icon}"></i></span><span class="wz-ct"><b>${t.title}</b><small>${t.sub}</small></span><span class="wz-ck" aria-hidden="true"><i class="fa-solid fa-check"></i></span></button>`; };
  return `<div role="radiogroup" aria-label="نوع العملية" class="wz-cards">${card('jamiya')}${card('family')}${card('qattah')}</div>
    <div class="wz-or"><span>مسار الديون</span></div>${card('debt', 'wz-debt')}`;
}
function wzBarHtml(step) {
  const next = rtl => `<i class="fa-solid ${rtl ? 'fa-arrow-left' : 'fa-arrow-right'}"></i>`, back = rtl => `<i class="fa-solid ${rtl ? 'fa-arrow-right' : 'fa-arrow-left'}"></i>`, r = wzRtl();
  const sum = '<p class="wz-sum" data-wz-sum aria-live="polite"></p>';
  if (step === 4) return `${sum}<div class="wz-btns"><button type="button" class="btn b-sec" data-act="wz-edit"><i class="fa-solid fa-pen"></i> تعديل البيانات</button><button type="submit" class="btn b-pri" data-wz-submit><i class="fa-solid fa-circle-check"></i> تأكيد الإنشاء</button></div>`;
  return `${sum}<div class="wz-btns"><button type="button" class="btn b-sec" data-act="wz-back">${back(r)} السابق</button><button type="button" class="btn b-pri" data-act="wz-next">${step === 2 ? 'التالي: المعاينة' : 'التالي: المراجعة'} ${next(r)}</button></div>`;
}
// حماية من نسخ قديمة مخزنة مؤقتاً (ملف قديم لا يحوي الدالة): نمسح الذاكرة ونعيد التحميل مرة واحدة فقط
function wzStale(fn) {
  try { if (!sessionStorage.getItem('jm_wz_reload')) { sessionStorage.setItem('jm_wz_reload', '1');
    (window.caches ? caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k)))) : Promise.resolve()).catch(() => {}).then(() => location.reload()); } } catch (e) {}
  return `<div class="wz-note amber" role="alert">يلزم تحديث التطبيق لعرض هذا النموذج. جارٍ إعادة التحميل… إن لم يحدث ذلك فحدّث الصفحة يدوياً. (${fn})</div>`;
}
const wzFn = (name, call) => typeof window[name] === 'function' ? call() : wzStale(name);
const WZ_FIELDS = { jamiya: () => wzFn('jamiyaFieldsHtml', () => jamiyaFieldsHtml()), family: () => wzFn('familyFieldsHtml', () => familyFieldsHtml()), qattah: () => wzFn('qtFieldsHtml', () => qtFieldsHtml(null, 'wizard')), debt: () => wzFn('dbFieldsHtml', () => dbFieldsHtml()) };
const WZ_INTRO = {
  jamiya: '', qattah: '<div class="wz-note amber">القطة صندوق مشترك لفعالية أو رحلة: تحدد الهدف والمدتين، ثم يسجّل المشرف المدفوعات ويعيّن نائباً يسجّل المصروفات معه. من تضيفه مباشرة يراها في حسابه فور دخوله.</div>', family: '', debt: ''
};
function wzIconSummary(icon) { return icon ? `<span class="wz-ic-cur">${wzE(icon)}</span>` : '<span class="wz-ic-cur"><i class="fa-solid fa-people-roof"></i></span>'; }
function wzReuseHtml() {
  const uid = state.user && state.user.uid; if (!uid) return '';
  const list = (state.jamiyat || []).filter(j => j.creatorUid === uid && !j.type).sort((a, b) => ((b.createdAt && b.createdAt.seconds) || 0) - ((a.createdAt && a.createdAt.seconds) || 0)).slice(0, 8);
  if (!list.length) return '';
  return `<div class="wz-reuse"><label class="wz-lb" for="wz-reuse">ابدأ من إعدادات جمعية سابقة (اختياري)</label>
    <select id="wz-reuse" class="inp" data-wz-reuse><option value="">— إعدادات جديدة —</option>${list.map(j => `<option value="${wzE(j.id)}">${wzE(j.name)} • ${wzE(freqOf(j).label)} • ${wzNf(j.count)} × ${wzNf(j.amount)}</option>`).join('')}</select>
    <p class="wz-hint">تُنسخ الدورية وعدد الأعضاء والقسط وأيام السداد فقط، أما الاسم والتواريخ والأعضاء فتبقى جديدة.</p></div>`;
}
function wzShell(type, fields) {
  const wz = wzS();
  if (!type) return `<div class="wz max-w-xl mx-auto card p-5 sm:p-8" data-wz data-step="1"><div class="wz-head"><h3>إنشاء جديد</h3><button type="button" data-act="go-home" class="wz-x" aria-label="إغلاق"><i class="fa-solid fa-xmark"></i></button></div>
    ${wzProgressHtml(1, 1)}<section data-wz-panel="1" aria-labelledby="wz-h1"><h4 id="wz-h1" class="wz-h" tabindex="-1">ماذا تريد أن تنشئ؟</h4>${wzTypeCards(state.createType)}</section></div>`;
  const t = WZ_TYPES[type], extra = type === 'jamiya' ? wzReuseHtml() : '';
  return `<div class="wz max-w-xl mx-auto card p-5 sm:p-8" data-wz data-type="${type}" data-step="${wz.step}">
    <div class="wz-head"><h3>إنشاء جديد</h3><button type="button" data-act="go-home" class="wz-x" aria-label="إغلاق"><i class="fa-solid fa-xmark"></i></button></div>
    <div data-wz-prog>${wzProgressHtml(wz.step, wz.max)}</div>
    <form id="${t.formId}" class="wz-form" novalidate data-wz-form>
      <section data-wz-panel="2" class="${wz.step === 2 ? '' : 'hide'}" aria-labelledby="wz-h2"><h4 id="wz-h2" class="wz-h" tabindex="-1"><i class="fa-solid ${t.icon}"></i> ${t.title}</h4>
        <div data-wz-draft class="wz-note slate hide">استعدنا بيانات غير مكتملة من جلسة سابقة. <button type="button" class="wz-link" data-act="wz-clear-draft">ابدأ من جديد</button></div>
        <div data-wz-alert class="wz-alert hide" role="alert"></div>
        ${WZ_INTRO[type] || ''}${extra}
        <div class="wz-fields space-y-4">${fields}</div>
        <div class="wz-live" data-wz-live aria-live="polite"></div></section>
      <section data-wz-panel="3" class="${wz.step === 3 ? '' : 'hide'}" aria-labelledby="wz-h3"><h4 id="wz-h3" class="wz-h" tabindex="-1">المعاينة المالية</h4><div data-wz-preview></div></section>
      <section data-wz-panel="4" class="${wz.step === 4 ? '' : 'hide'}" aria-labelledby="wz-h4"><h4 id="wz-h4" class="wz-h" tabindex="-1">مراجعة وتأكيد</h4><div data-wz-review></div></section>
      <div class="wz-bar" data-wz-bar>${wzBarHtml(wz.step)}</div>
    </form></div>`;
}
function wzView() {
  const wz = wzS();
  if (wz.done) return wzDoneHtml(wz.done);
  const t = state.createType;
  if (wz.step === 1 || !WZ_TYPES[t]) return wzShell(null);
  return wzShell(t, WZ_FIELDS[t]());
}

/* ---- قراءة النموذج الحقيقي وإعادته ---- */
function wzSnap(form) {
  const out = {};
  Array.from(form.elements).forEach(el => {
    if (!el.name || el.type === 'button' || el.type === 'submit' || el.type === 'file') return;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value;
  });
  return out;
}
function wzRestore(form, data) {
  if (!data) return;
  const setEl = (el, val) => {
    if (el.type === 'checkbox') el.checked = !!val;
    else if (el.type === 'radio') el.checked = el.value === val;
    else el.value = val;
  };
  ['frequency', 'mode'].forEach(n => { const el = form.elements[n]; if (el && data[n] != null && el.value !== data[n]) { el.value = data[n]; el.dispatchEvent(new Event('change', { bubbles: true })); } });
  Object.keys(data).forEach(k => {
    if (k === 'frequency' || k === 'mode') return;
    const f = form.elements[k]; if (!f) return;
    if (f.length && f[0] && f[0].type === 'radio') Array.from(f).forEach(r => setEl(r, data[k])); else setEl(f, data[k]);
  });
  const ic = form.elements.icon; if (ic) form.querySelectorAll('.emo').forEach(b => b.classList.toggle('on', b.dataset.v === String(ic.value || '').trim()));
}
function wzValues(type, form) { return wzParse(type, wzSnap(form)); }

/* ---- المسودة (localStorage) ---- */
const wzDraftKey = () => 'jm_wz_' + (state.user ? state.user.uid : 'x');
function wzDraftLoad() { try { const d = JSON.parse(lsGet(wzDraftKey()) || 'null'); return d && d.ts && Date.now() - d.ts < 14 * 86400000 ? d : null; } catch (e) { return null; } }
function wzDraftSave() {
  const wz = wzS(), out = { ts: Date.now(), data: {} };
  Object.keys(WZ_TYPES).forEach(t => { const d = wz.data[t] || {}; if (!wzHasContent(t, d)) return; out.data[t] = {}; Object.keys(d).forEach(k => { if (!WZ_NO_DRAFT.includes(k)) out.data[t][k] = d[k]; }); });
  if (Object.keys(out.data).length) lsSet(wzDraftKey(), JSON.stringify(out)); else wzDraftClear();
}
function wzDraftClear() { try { localStorage.removeItem(wzDraftKey()); } catch (e) {} }
let wzSaveT = null; const wzSaveSoon = () => { clearTimeout(wzSaveT); wzSaveT = setTimeout(wzDraftSave, 500); };

/* ---- تهيئة الحقول بعد كل عرض ---- */
function wzEnhance(form, type) {
  form.querySelectorAll('input[type=number]').forEach(el => {
    el.dataset.min = el.getAttribute('min') || ''; el.dataset.max = el.getAttribute('max') || '';
    el.removeAttribute('min'); el.removeAttribute('max'); el.removeAttribute('step');
    el.type = 'text'; el.setAttribute('inputmode', WZ_NUMERIC_DECIMAL.includes(el.name) ? 'decimal' : 'numeric');
    el.setAttribute('autocomplete', 'off'); el.setAttribute('enterkeyhint', 'next'); el.dataset.num = '1';
  });
  const ph = form.elements.cphone; if (ph) { ph.setAttribute('inputmode', 'tel'); ph.setAttribute('autocomplete', 'off'); }
  const ib = form.elements.iban; if (ib) { ib.setAttribute('autocapitalize', 'characters'); ib.setAttribute('spellcheck', 'false'); ib.setAttribute('autocomplete', 'off'); }
  form.querySelectorAll('input.inp,textarea.inp,select.inp').forEach(el => { if (!el.id && el.name) el.id = 'wz-f-' + el.name; });
  form.querySelectorAll('label').forEach(l => { const inp = l.parentElement && l.parentElement.querySelector('input.inp,select.inp,textarea.inp'); if (inp && inp.id && !l.htmlFor) l.htmlFor = inp.id; });
  // منتقي الرمز: مطوي بملخص صغير بدل ثلاثة صفوف من الرموز
  const ic = form.elements.icon;
  if (ic && !form.querySelector('.wz-icon')) {
    const box = ic.parentElement, lbl = box.querySelector('label');
    if (lbl) { const det = document.createElement('details'); det.className = 'wz-icon';
      const sm = document.createElement('summary'); sm.innerHTML = `<span class="wz-lb">رمز الجمعية (اختياري)</span><span class="wz-ic-sum" data-wz-icsum>${wzIconSummary(ic.value)}<i class="fa-solid fa-chevron-down"></i></span>`;
      lbl.style.display = 'none'; box.parentNode.insertBefore(det, box); det.appendChild(sm); det.appendChild(box); }
  }
  // مقترح الاسم
  const nm = form.elements.jname || form.elements.qname;
  if (nm && !form.querySelector('[data-wz-suggest]')) { const b = document.createElement('button'); b.type = 'button'; b.className = 'wz-chip hide'; b.dataset.act = 'wz-suggest'; b.dataset.wzSuggest = '1'; nm.parentElement.appendChild(b); }
}
function wzApplyDefaults(form, type) {
  const E = wzEnv(), set = (n, val, auto) => { const el = form.elements[n]; if (el && el.value === '' && val != null) { el.value = val; if (auto) el.dataset.auto = '1'; } };
  if (type === 'jamiya') {
    const fq = form.elements.frequency ? form.elements.frequency.value : 'monthly', d = wzDayDefaults(fq);
    set('start', wzDefaultStart(fq, E.today), true); set('lastDay', d.lastDay, true); set('payDay', d.payDay, true);
  } else if (type === 'qattah') set('qcs', E.today, true);
}
function wzSetDraftNotice(form, show) { const n = form.querySelector('[data-wz-draft]'); if (n) n.classList.toggle('hide', !show); }
function wzAfterRender() {
  const wz = state.wz; if (wz && wz.done && state.view !== 'create') wz.done = null;
  const root = document.querySelector('[data-wz]'); if (!root) return;
  const type = root.dataset.type, form = root.querySelector('[data-wz-form]'); if (!type || !form || form.dataset.wzInit) return;
  form.dataset.wzInit = '1';
  const w = wzS();
  wzEnhance(form, type);
  if (!wzHasContent(type, w.data[type])) { const d = wzDraftLoad(); if (d && d.data && d.data[type] && wzHasContent(type, d.data[type])) { w.data[type] = Object.assign({}, d.data[type]); w.restored[type] = true; } }
  wzRestore(form, w.data[type]);
  wzApplyDefaults(form, type);
  wzSetDraftNotice(form, !!w.restored[type] && wzHasContent(type, w.data[type]));
  wzApplyStep(root, form, type, w.step, true);
  wzRefreshLive();
}

/* ---- الملخص الفوري والمعاينة والمراجعة ---- */
const wzTile = (t, v, c) => `<div class="wz-tile ${c || ''}"><span>${t}</span><b>${v}</b></div>`;
const wzDash = '—';
function wzPlanTiles(type, p, v) {
  const m = x => x == null ? wzDash : wzMoney(x), n = x => x == null ? wzDash : wzNf(x);
  if (type === 'jamiya') return [wzTile('إجمالي الدورة الواحدة', m(p.pot), 'main'), wzTile('عدد الأعضاء', n(p.members)), wzTile('مساهمة العضو في كل دورة', m(p.perCycle)),
    wzTile('المدة', p.cycles == null ? wzDash : (p.frequency === 'monthly' ? `${wzNf(p.cycles)} شهراً` : `${wzNf(p.cycles)} دورة${p.spanDays ? ` (${wzNf(p.spanDays)} يوماً)` : ''}`)),
    wzTile('بداية الدورة الأولى', p.first ? wzFmtD(p.first) : wzDash), wzTile('نهاية الجمعية', p.last ? wzFmtD(p.last) : wzDash), wzTile('إجمالي المتداول خلال الجمعية', m(p.total), 'wide')].join('');
  if (type === 'qattah') return [wzTile('الهدف المالي', m(p.target), 'main'), wzTile('حصة كل فرد (بالتساوي)', m(p.share)), wzTile('إجمالي المساهمات المتوقعة', m(p.expected)),
    wzTile('المتبقي للوصول إلى الهدف', m(p.remaining)), wzTile('مدة الجمع', p.collectDays == null ? wzDash : `${wzNf(p.collectDays)} يوماً`)].join('');
  if (type === 'family') {
    if (p.mode === 'monthly') return [wzTile('الهدف المالي', m(p.target), 'main'), wzTile('الاشتراك الشهري للعضو', p.monthlyAmount == null ? 'يحدده كل عضو' : m(p.monthlyAmount)),
      wzTile('حصة العضو الكلية (بالتساوي)', m(p.share)), wzTile('المتبقي للوصول إلى الهدف', m(p.remaining)),
      wzTile('المدة التقديرية', p.months == null ? wzDash : `${wzNf(p.months)} شهراً${p.finish ? ' • حتى ' + (typeof fmtMonth === 'function' ? fmtMonth(p.finish) : '') : ''}`, 'wide')].join('');
    return [wzTile('الهدف المالي', p.target == null ? 'غير محدد' : m(p.target), 'main'), wzTile('حصة الفرد المتوقعة (بالتساوي)', m(p.share)), wzTile('إجمالي المساهمات المتوقعة', m(p.expected)),
      wzTile('المتبقي للوصول إلى الهدف', m(p.remaining)), wzTile('ينتهي التعاون', p.endDate ? `${wzFmtIso(p.endDate)} • بعد ${wzNf(p.daysLeft)} يوماً` : wzDash, 'wide')].join('');
  }
  const stl = { late: 'متأخر', soon: 'مستحق قريباً', open: 'مفتوح' }[p.status];
  return [wzTile('أصل الدين', m(p.principal), 'main'), wzTile('إجمالي ما سُدِّد', p.paid == null ? wzDash : m(p.paid)), wzTile('الرصيد المتبقي', m(p.remaining)),
    wzTile('تاريخ الاستحقاق', p.due ? wzFmtIso(p.due) : 'غير محدد'), wzTile('الحالة', p.ready ? stl : wzDash, p.status === 'late' ? 'bad' : p.status === 'soon' ? 'warn' : '')].join('');
}
function wzSummaryLine(type, p) {
  const m = wzMoney, none = 'أكمل البيانات لعرض الملخص';
  if (type === 'jamiya') return p.pot == null ? none : `إجمالي الدورة ${m(p.pot)} • ${wzNf(p.cycles)} دورة`;
  if (type === 'qattah') return p.share == null ? none : `حصة الفرد ${m(p.share)} • الهدف ${m(p.target)}`;
  if (type === 'family') return p.target == null ? none : `الهدف ${m(p.target)}`;
  return p.principal == null ? none : `المتبقي ${m(p.remaining)}`;
}
function wzRefreshLive() {
  const root = document.querySelector('[data-wz]'); if (!root) return;
  const type = root.dataset.type, form = root.querySelector('[data-wz-form]'); if (!type || !form) return;
  const v = wzValues(type, form), p = wzPlan(type, v);
  const live = form.querySelector('[data-wz-live]'); if (live) live.innerHTML = `<p class="wz-lt"><i class="fa-solid fa-calculator"></i> ملخص فوري</p><div class="wz-tiles">${wzPlanTiles(type, p, v)}</div>`;
  const sum = form.querySelector('[data-wz-sum]'); if (sum) sum.textContent = wzSummaryLine(type, p);
  const chip = form.querySelector('[data-wz-suggest]'), nm = form.elements.jname || form.elements.qname;
  if (chip && nm) { const sg = wzSuggestName(type, { frequency: v.frequency, lang: wzEnv().lang }); chip.textContent = 'اقتراح: ' + sg; chip.dataset.v = sg; chip.classList.toggle('hide', !!nm.value.trim()); }
}
// تسمية الدورة بنفس دالة التطبيق (شهر كامل للشهرية، أو نطاق أيام لغيرها)
const wzPeriodLabel = (c, freq) => (typeof periodLabel === 'function' ? periodLabel({ startDate: wzIso(c.from), frequency: freq }, 0) : wzFmtD(c.from) + ' – ' + wzFmtD(c.to));
function wzScheduleHtml(p) {
  if (!p.schedule) return '';
  const row = c => `<li class="wz-row"><span class="wz-n">${wzNf(c.n)}</span><span class="wz-rm"><b>${wzE(wzPeriodLabel(c, p.frequency))}</b><small>آخر سداد ${wzFmtD(c.due)} • الاستلام ${wzFmtD(c.payout)}</small></span><span class="wz-rr">يُحدد لاحقاً</span></li>`;
  const first = p.schedule.slice(0, 4).map(row).join(''), rest = p.schedule.slice(4).map(row).join('');
  return `<div class="wz-sch"><p class="wz-lt"><i class="fa-solid fa-calendar-days"></i> جدول الدورات والمستفيدين</p><ol class="wz-rows">${first}</ol>
    ${rest ? `<details class="wz-more"><summary>عرض باقي الدورات (${wzNf(p.schedule.length - 4)})</summary><ol class="wz-rows">${rest}</ol></details>` : ''}
    <p class="wz-hint">ترتيب المستفيدين يُحدد من صفحة الجمعية بعد انضمام الأعضاء وقبل بدء الدورة الأولى، لذلك لا تظهر الأسماء هنا.</p></div>`;
}
function wzNotes(type, v, p, warns) {
  const n = [];
  if (type === 'qattah' && p.rounding) n.push(`التقريب: مجموع الحصص ${wzMoney(p.expected)} ويقل عن الهدف بمقدار ${wzMoney(p.rounding)}.`);
  if (type === 'family' && p.mode === 'once' && p.rounding) n.push(`التقريب: مجموع الحصص ${wzMoney(p.expected)} ويقل عن الهدف بمقدار ${wzMoney(p.rounding)}.`);
  if (type === 'family' && !v.participants) n.push('أدخل «عدد المشاركين المتوقع» في خطوة البيانات لتظهر حصة الفرد التقديرية. المساهمات في التعاون بمبالغ حرة ولا تُلزَم بحصة.');
  if (type === 'family' && v.mode === 'monthly') n.push('تقدير المدة يفترض أن يسدد جميع الأعضاء اشتراكهم كل شهر. ويُغلق التعاون تلقائياً عند بلوغ المبلغ المستهدف.');
  return n.concat(warns || []);
}
function wzNotesHtml(list) { return list.length ? `<div class="wz-notes">${list.map(t => `<p><i class="fa-solid fa-circle-info"></i> <span>${wzE(t)}</span></p>`).join('')}</div>` : ''; }
function wzPreviewHtml(type, v, form) {
  const val = wzValidate(type, v), p = wzPlan(type, v);
  return `<div class="wz-tiles">${wzPlanTiles(type, p, v)}</div>${type === 'jamiya' ? wzScheduleHtml(p) : ''}${wzNotesHtml(wzNotes(type, v, p, val.warnings))}`;
}
const WZ_KIND = { lent: 'أقرضت — لي عند الطرف الآخر', borrowed: 'اقترضت — عليّ للطرف الآخر', loan: 'استلاف — طلب قرض من شخص مسجّل' };
function wzMaskIban(s) { return s && s.length > 8 ? s.slice(0, 4) + ' •••• •••• ' + s.slice(-4) : s; }
function wzReviewRows(type, v, p) {
  const R = (k, x) => [k, x == null || x === '' ? wzDash : x], m = wzMoney;
  if (type === 'jamiya') return [R('النوع', 'جمعية دورية'), R('الاسم', wzE(v.name)), R('الدورية', wzE(p.freqLabel)), R('عدد الأعضاء (= عدد الدورات)', wzNf(v.count)), R('مساهمة العضو', m(p.perCycle)),
    R('إجمالي الدورة', m(p.pot)), R('بداية الدورة الأولى', p.first ? wzFmtD(p.first) : null), R('نهاية الجمعية', p.last ? wzFmtD(p.last) : null),
    R('آخر يوم للسداد', 'اليوم ' + wzNf(v.lastDay)), R('يوم الاستلام', 'اليوم ' + wzNf(v.payDay)), R('مشاركتك', v.joinSelf ? 'عضو ومشرف' : 'مشرف فقط')];
  if (type === 'family') return [R('النوع', 'تعاون عائلي'), R('الاسم', wzE(v.name)), R('الهدف', wzE(v.goal)), R('الأسباب', wzE(v.reasons.length > 90 ? v.reasons.slice(0, 90) + '…' : v.reasons)),
    R('نوع التعاون', v.mode === 'monthly' ? 'مستمر شهرياً' : 'فترة واحدة'),
    ...(v.mode === 'monthly' ? [R('المبلغ المستهدف', m(p.target)), R('يوم السداد من كل شهر', wzNf(v.monthlyDay)), R('الاشتراك الشهري', p.monthlyAmount ? m(p.monthlyAmount) : 'يحدده كل عضو')]
      : [R('المبلغ المستهدف', p.target ? m(p.target) : 'غير محدد'), R('تاريخ النهاية', wzFmtIso(v.endDate))]),
    R('البنك', wzE(v.bank === wzEnv().otherBank ? v.bankOther : v.bank)), R('الآيبان', `<span dir="ltr">${wzE(wzMaskIban(v.iban))}</span>`), R('المستفيد', 'أنت')];
  if (type === 'qattah') return [R('النوع', 'قطة مشتركة'), R('الاسم', wzE(v.name)), R('السبب', wzE(v.reason)), R('القيمة المطلوبة', m(p.target)), R('عدد المشاركين', wzNf(v.participants)), R('حصة الفرد', m(p.share)),
    R('فترة الجمع', `${wzFmtIso(v.collectStart)} ← ${wzFmtIso(v.collectEnd)}`), R('الفعالية / الرحلة', `${wzFmtIso(v.eventStart)} ← ${wzFmtIso(v.eventEnd)}`)];
  const after = v.kind === 'loan' ? 'بانتظار تحويل المُقرض' : v.phoneRaw ? 'يُرسل للطرف الآخر ليقبله إن كان مسجلاً، وإلا يُسجَّل مفتوحاً' : 'يُسجَّل مفتوحاً';
  return [R('النوع', 'دين'), R('نوع الدين', WZ_KIND[v.kind]), R('الطرف الآخر', wzE(v.name)), R('الجوال', v.phoneRaw ? `<span dir="ltr">${wzE(v.phoneRaw)}</span>` : null), R('أصل الدين', m(p.principal)),
    R('السبب', wzE(v.reason)), R('تاريخ الدين', wzFmtIso(v.start)), R('موعد السداد', v.due ? wzFmtIso(v.due) : 'غير محدد'), R('بعد الحفظ', after)];
}
function wzReviewHtml(type, v) {
  const val = wzValidate(type, v), p = wzPlan(type, v);
  const rows = wzReviewRows(type, v, p).map(([k, x]) => `<div class="wz-kv"><dt>${k}</dt><dd>${x}</dd></div>`).join('');
  const bad = !val.ok ? `<div class="wz-alert" role="alert">توجد بيانات ناقصة أو غير صحيحة. اضغط «تعديل البيانات» لتصحيحها.</div>` : '';
  const sch = type === 'jamiya' && p.schedule ? `<details class="wz-more"><summary>جدول الدورات (${wzNf(p.schedule.length)})</summary><ol class="wz-rows">${p.schedule.map(c => `<li class="wz-row"><span class="wz-n">${wzNf(c.n)}</span><span class="wz-rm"><b>${wzFmtD(c.from)} – ${wzFmtD(c.to)}</b><small>آخر سداد ${wzFmtD(c.due)} • الاستلام ${wzFmtD(c.payout)}</small></span></li>`).join('')}</ol></details>` : '';
  return `${bad}<dl class="wz-kvs">${rows}</dl>${sch}${wzNotesHtml(val.warnings)}`;
}

/* ---- التنقل بين الخطوات (بلا إعادة رسم، فلا تضيع المدخلات) ---- */
function wzApplyStep(root, form, type, n, silent) {
  const wz = wzS(); wz.step = n; wz.max = Math.max(wz.max || 1, n); root.dataset.step = n;
  root.querySelectorAll('[data-wz-panel]').forEach(p => p.classList.toggle('hide', +p.dataset.wzPanel !== n));
  const pr = root.querySelector('[data-wz-prog]'); if (pr) pr.innerHTML = wzProgressHtml(n, wz.max);
  const bar = form.querySelector('[data-wz-bar]'); if (bar) bar.innerHTML = wzBarHtml(n);
  if (n === 3) form.querySelector('[data-wz-preview]').innerHTML = wzPreviewHtml(type, wzValues(type, form), form);
  if (n === 4) form.querySelector('[data-wz-review]').innerHTML = wzReviewHtml(type, wzValues(type, form));
  wzRefreshLive();
  if (!silent) { const h = root.querySelector(`#wz-h${n}`); window.scrollTo({ top: Math.max(0, root.getBoundingClientRect().top + window.scrollY - 70), behavior: 'smooth' }); if (h) h.focus({ preventScroll: true }); }
}
function wzGo(n) {
  const root = document.querySelector('[data-wz]'); if (!root) return;
  const form = root.querySelector('[data-wz-form]'), type = root.dataset.type;
  if (n <= 1 || !form) { if (form) wzS().data[type] = wzSnap(form); wzS().step = 1; state.createType = type || state.createType; render(); window.scrollTo({ top: 0 }); return; }
  wzApplyStep(root, form, type, Math.min(4, n), false);
}
function wzClearErrors(form) {
  form.querySelectorAll('.wz-err').forEach(x => x.remove());
  form.querySelectorAll('[aria-invalid]').forEach(x => { x.removeAttribute('aria-invalid'); x.removeAttribute('aria-describedby'); });
  const al = form.querySelector('[data-wz-alert]'); if (al) al.classList.add('hide');
}
function wzShowError(form, name, msg) {
  const el = form.elements[name]; if (!el || el.length) return null;
  const old = form.querySelector(`#wz-err-${name}`); if (old) old.remove();
  const p = document.createElement('p'); p.className = 'wz-err'; p.id = 'wz-err-' + name; p.setAttribute('role', 'alert'); p.textContent = msg;
  el.parentElement.appendChild(p); el.setAttribute('aria-invalid', 'true'); el.setAttribute('aria-describedby', p.id); return el;
}
function wzShowErrors(form, errors) {
  wzClearErrors(form); let first = null;
  Object.keys(errors).forEach(k => { const el = wzShowError(form, k, errors[k]); if (el && !first) first = el; });
  const keys = Object.keys(errors), al = form.querySelector('[data-wz-alert]');
  if (al && keys.length) { al.textContent = keys.length === 1 ? 'يرجى تصحيح حقل واحد قبل المتابعة' : `يرجى تصحيح ${wzNf(keys.length)} حقول قبل المتابعة`; al.classList.remove('hide'); }
  if (first) { first.scrollIntoView({ block: 'center', behavior: 'smooth' }); first.focus({ preventScroll: true }); }
}
function wzNext() {
  const root = document.querySelector('[data-wz]'); if (!root) return;
  const form = root.querySelector('[data-wz-form]'), type = root.dataset.type, n = wzS().step;
  if (n === 2) {
    wzNormalizeNumbers(form);
    const r = wzValidate(type, wzValues(type, form));
    if (!r.ok) { wzShowErrors(form, r.errors); return; }
    wzClearErrors(form);
  }
  wzGo(n + 1);
}
function wzNormalizeNumbers(form) { form.querySelectorAll('input[data-num]').forEach(el => { const t = wzNormNumber(el.value); if (el.value.trim() !== '' && /^\d+(\.\d+)?$/.test(t) && t !== el.value) el.value = t; }); }

/* ---- بعد الإنشاء ---- */
function wzDone(type, id, name) {
  const wz = wzS(); wz.data[type] = {}; wz.restored[type] = false; wzDraftClear();
  if (state.view !== 'create') { wzOpen(type, id); return; }
  wz.done = { type, id, name, ts: Date.now() }; window.scrollTo({ top: 0 }); render();
}
function wzOpen(type, id, invite) {
  const wz = wzS(); wz.done = null; wz.step = 1;
  if (type === 'jamiya' || type === 'family') { if (invite) state.afterOpen = { id, act: 'invite-modal' }; openJamiya(id); }
  else if (type === 'qattah') { qtOpen(id); if (invite) { QT.tab = 'people'; render(); } }
  else dbOpen(id);
}
function wzDoneHtml(d) {
  const t = WZ_TYPES[d.type], inv = d.type !== 'debt';
  const next = { jamiya: 'ادعُ الأعضاء ثم رتّب المستفيدين قبل بدء الدورة الأولى.', family: 'ادعُ أفراد العائلة ليساهموا، وراجع الإيصالات حين تصلك.', qattah: 'أضف المشاركين، وسجّل المدفوعات والمصروفات من صفحة القطة.', debt: 'تابع السداد وسجّل الدفعات من صفحة الدين.' }[d.type];
  return `<div class="wz max-w-xl mx-auto card p-6 sm:p-8 text-center wz-ok" data-wz data-step="done" role="status"><span class="wz-okc"><i class="fa-solid fa-check"></i></span>
    <h3 class="font-black text-xl mt-4">تم إنشاء ${t.done} بنجاح</h3><p class="text-sm text-slate-600 mt-1 break-words">${wzE(d.name || '')}</p><p class="wz-hint mt-3">${next}</p>
    <div class="grid gap-2 mt-5"><button type="button" class="btn b-pri w-full py-3" data-act="wz-open" data-t="${d.type}" data-id="${wzE(d.id)}"><i class="fa-solid fa-arrow-up-right-from-square"></i> فتح التفاصيل</button>
      ${inv ? `<button type="button" class="btn b-sec w-full py-3" data-act="wz-open" data-invite="1" data-t="${d.type}" data-id="${wzE(d.id)}"><i class="fa-solid fa-user-plus"></i> ${d.type === 'qattah' ? 'إضافة المشاركين' : 'دعوة الأعضاء'}</button>` : ''}
      <button type="button" class="btn b-sec w-full py-3" data-act="wz-again"><i class="fa-solid fa-plus"></i> إنشاء عملية أخرى</button></div></div>`;
}

/* ---- الأحداث ---- */
const WZ_ACTIONS = {
  'wz-type': el => { document.querySelectorAll('.wz-card').forEach(c => { const on = c === el; c.classList.toggle('on', on); c.setAttribute('aria-checked', on); }); setTimeout(() => wzStart(el.dataset.v), 170); },
  'wz-next': wzNext,
  'wz-back': () => wzGo(wzS().step - 1),
  'wz-edit': () => wzGo(2),
  'wz-step': el => wzGo(+el.dataset.n),
  'wz-again': () => wzStart(null),
  'wz-open': el => wzOpen(el.dataset.t, el.dataset.id, !!el.dataset.invite),
  'wz-suggest': el => { const f = el.closest('form'), nm = f && (f.elements.jname || f.elements.qname); if (nm) { nm.value = el.dataset.v || ''; nm.dispatchEvent(new Event('input', { bubbles: true })); nm.focus(); } },
  'wz-clear-draft': () => { const root = document.querySelector('[data-wz]'); if (!root) return; const t = root.dataset.type, w = wzS(); w.data[t] = {}; w.restored[t] = false; wzDraftSave(); render(); }
};
if (typeof document !== 'undefined') {
  document.addEventListener('input', e => {
    const t = e.target, form = t && t.form; if (!form || !form.hasAttribute('data-wz-form')) return;
    if (t.dataset.num) { const d = wzDigits(t.value); if (d !== t.value) { const pos = t.selectionStart; t.value = d; try { t.setSelectionRange(pos, pos); } catch (er) {} } }
    delete t.dataset.auto;
    const root = document.querySelector('[data-wz]'), type = root && root.dataset.type; if (!type) return;
    const w = wzS(); w.data[type] = wzSnap(form); wzSaveSoon();
    const er = form.querySelector('#wz-err-' + t.name); if (er) { er.remove(); t.removeAttribute('aria-invalid'); t.removeAttribute('aria-describedby'); }
    if (t.name === 'icon') { const s = form.querySelector('[data-wz-icsum]'); if (s) s.innerHTML = wzIconSummary(t.value.trim()) + '<i class="fa-solid fa-chevron-down"></i>'; }
    cancelAnimationFrame(wzRaf); wzRaf = requestAnimationFrame(wzRefreshLive);
  });
  let wzRaf = 0;
  document.addEventListener('change', e => {
    const t = e.target, form = t && t.form; if (!form || !form.hasAttribute('data-wz-form')) return;
    setTimeout(() => {
      const root = document.querySelector('[data-wz]'), type = root && root.dataset.type; if (!type) return;
      if (t.matches('select[data-freq]')) { const d = wzDayDefaults(t.value); ['lastDay', 'payDay'].forEach(n => { const el = form.elements[n]; if (el && el.dataset.auto === '1') el.value = d[n]; }); const st = form.elements.start; if (st && st.dataset.auto === '1') st.value = wzDefaultStart(t.value, wzEnv().today); }
      if (t.matches('[data-wz-reuse]')) wzApplyReuse(form, t.value);
      wzS().data[type] = wzSnap(form); wzSaveSoon(); wzRefreshLive();
    }, 0);
  });
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('.wz-form .emo'); if (!b) return;
    setTimeout(() => { const f = b.closest('form'), s = f && f.querySelector('[data-wz-icsum]'); if (s && f.elements.icon) s.innerHTML = wzIconSummary(f.elements.icon.value.trim()) + '<i class="fa-solid fa-chevron-down"></i>'; const root = document.querySelector('[data-wz]'); if (root && f) { wzS().data[root.dataset.type] = wzSnap(f); wzSaveSoon(); } }, 0);
  });
  document.addEventListener('focusout', e => {
    const t = e.target, form = t && t.form; if (!form || !form.hasAttribute('data-wz-form') || !t.name || wzS().step !== 2) return;
    if (!t.value || t.type === 'checkbox' || t.type === 'radio') return;
    const root = document.querySelector('[data-wz]'), type = root && root.dataset.type; if (!type) return;
    if (t.dataset.num) wzNormalizeNumbers(form);
    const r = wzValidate(type, wzValues(type, form)); if (r.errors[t.name]) wzShowError(form, t.name, r.errors[t.name]);
  });
  // الإرسال: لا يُحفظ شيء قبل خطوة التأكيد، وعند التأكيد يُعاد التحقق ثم يمر الحدث إلى المعالج الأصلي
  document.addEventListener('submit', e => {
    const form = e.target; if (!form || !form.hasAttribute || !form.hasAttribute('data-wz-form')) return;
    const root = document.querySelector('[data-wz]'), type = root && root.dataset.type, step = wzS().step;
    if (step !== 4) { e.preventDefault(); e.stopImmediatePropagation(); wzNext(); return; }
    wzNormalizeNumbers(form);
    const r = wzValidate(type, wzValues(type, form));
    if (!r.ok) { e.preventDefault(); e.stopImmediatePropagation(); wzGo(2); wzShowErrors(form, r.errors); return; }
    const btn = form.querySelector('[data-wz-submit]'); if (btn) { btn.disabled = true; setTimeout(() => { if (btn.isConnected) btn.disabled = false; }, 2500); }
  }, true);
}
function wzApplyReuse(form, id) {
  const j = (state.jamiyat || []).find(x => x.id === id); if (!j) return;
  const f = form.elements;
  if (f.frequency && FREQS[j.frequency]) { f.frequency.value = j.frequency; f.frequency.dispatchEvent(new Event('change', { bubbles: true })); }
  if (f.count) f.count.value = j.count || ''; if (f.amount) f.amount.value = j.amount || '';
  setTimeout(() => { if (f.lastDay) { f.lastDay.value = j.lastDay || ''; delete f.lastDay.dataset.auto; } if (f.payDay) { f.payDay.value = j.payDay || ''; delete f.payDay.dataset.auto; }
    if (f.icon) { f.icon.value = j.icon || ''; f.icon.dispatchEvent(new Event('input', { bubbles: true })); } wzRefreshLive(); }, 0);
}

/* ---- لوحة المفاتيح: نخفي الشريطين الثابتين أثناء الكتابة حتى لا يحجبا الحقول (iOS/Android) ---- */
(function () {
  if (typeof document === 'undefined' || window.__wzKb) return; window.__wzKb = true;
  const isField = el => !!(el && el.matches && el.matches('input:not([type=radio]):not([type=checkbox]):not([type=button]):not([type=submit]),textarea,select'));
  let t = null;
  document.addEventListener('focusin', e => { if (isField(e.target) && e.target.closest && e.target.closest('[data-wz]')) { clearTimeout(t); document.documentElement.classList.add('wz-typing'); } });
  document.addEventListener('focusout', () => { clearTimeout(t); t = setTimeout(() => { if (!isField(document.activeElement)) document.documentElement.classList.remove('wz-typing'); }, 200); });
})();
