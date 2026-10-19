/* ============ الديون: سجلّ دين بين طرفين ============
   وحدة مستقلة تعتمد على متغيّرات التطبيق الرئيسي. تُحمَّل قبل السكربت الرئيسي.

   debts/{id}
     creatorUid, creatorName            مَن سجّل الدين
     kind                               'lent' (أنا أقرضت) | 'borrowed' (اقترضت)
     counterName, counterPhone          الطرف الآخر
     counterUid                         '' إن لم يكن مسجلاً في التطبيق
     amount, reason, startDate, dueDate ('' إن لم يُحدد)
     status                             'requested' (استلاف: بانتظار تحويل المُقرض) | 'proposed' | 'open' | 'closed' | 'declined'
  type                               'loan' للاستلاف (kind='borrowed' والدائن هو الطرف الآخر)
     paid                               مجموع الدفعات المؤكدة (يُحدَّث بـ increment)
   debts/{id}/payments/{pid}
     amount, date, note, byUid, byName, status ('pending' | 'confirmed' | 'rejected')
*/

const DB = { list: [], d: null, did: null, pays: [], tab: 'overview', unsubs: [], dUnsubs: [], seen: {}, pend: false };
const DB_COL = 'debts';

/* ---------- أدوات ---------- */
const dbJid = id => 'db:' + id;
const dbOther = d => d.creatorUid === state.user.uid ? d.counterUid : d.creatorUid; // الطرف الآخر (قد يكون غير مسجّل)
const dbRef = id => db.collection(DB_COL).doc(id);
const dbDay = () => isoDay(new Date());
const dbN = v => Number(v) || 0;
const dbDateOk = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const dbFmt = s => dbDateOk(s) ? new Date(s + 'T12:00:00').toLocaleDateString(LOCD(), { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const dbDays = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / DAY_MS);
const dbTs = v => { const d = v && v.toDate ? v.toDate() : null; return d ? d.getTime() : 0; };
const dbLeft = d => Math.max(0, dbN(d.amount) - dbN(d.paid));
const dbPct = d => dbN(d.amount) > 0 ? Math.min(100, Math.round(dbN(d.paid) / dbN(d.amount) * 100)) : 0;
// الدائن: في "أقرضت" هو المنشئ، وفي "اقترضت" هو الطرف الآخر
const dbIsLender = (d, uid) => d.kind === 'lent' ? d.creatorUid === uid : d.counterUid === uid;
const dbBox = (ttl, body) => `<div class="card p-5 space-y-3">${ttl ? `<h4 class="font-black text-sm">${ttl}</h4>` : ''}${body}</div>`;
const dbTile = (t, v, c = '') => `<div class="p-2.5 bg-slate-50 rounded-xl min-w-0"><p class="text-[10px] text-slate-500">${t}</p><b class="text-xs block truncate ${c}">${v}</b></div>`;
const dbEmpty = t => `<p class="text-xs text-slate-400 text-center py-3">${t}</p>`;

// الحالة المعروضة: بانتظار القبول، مرفوض، مسدد، مُعفى، متأخر، مفتوح
function dbStatus(d) {
  const left = dbLeft(d);
  if (d.status === 'proposed') return { k: 'proposed', l: 'بانتظار القبول', c: 'bg-sky-100 text-sky-700' };
  if (d.status === 'requested') return { k: 'requested', l: 'بانتظار التحويل', c: 'bg-sky-100 text-sky-700' };
  if (d.status === 'declined') return { k: 'declined', l: 'مرفوض', c: 'bg-slate-100 text-slate-600' };
  if (d.status === 'closed') return left > 0 ? { k: 'closed', l: 'مُعفى', c: 'bg-slate-100 text-slate-600' } : { k: 'closed', l: 'مسدد', c: 'bg-emerald-100 text-emerald-700' };
  if (left === 0) return { k: 'closed', l: 'مسدد', c: 'bg-emerald-100 text-emerald-700' };
  if (d.dueDate && d.dueDate < dbDay()) return { k: 'late', l: 'متأخر', c: 'bg-rose-100 text-rose-700' };
  return { k: 'open', l: 'مفتوح', c: 'bg-amber-100 text-amber-700' };
}

function dbTotals() {
  const me = state.user.uid; let owed = 0, owe = 0, late = 0;
  DB.list.forEach(d => {
    if (d.status !== 'open') return;
    const left = dbLeft(d);
    if (dbIsLender(d, me)) owed += left; else owe += left;
    if (dbStatus(d).k === 'late') late++;
  });
  return { owed: r2(owed), owe: r2(owe), late };
}

/* ---------- الاشتراك ---------- */
function dbLeave() {
  DB.dUnsubs.forEach(u => u()); DB.dUnsubs = [];
  DB.d = null; DB.did = null; DB.pays = [];
}
function stopDebts() {
  DB.unsubs.forEach(u => u()); DB.unsubs = [];
  dbLeave(); DB.list = []; DB.seen = {};
}
function dbRepaint() {
  if (!['home', 'debt'].includes(state.view)) return;
  const a = document.activeElement;
  if (a && a.closest && a.closest('#app') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) {
    if (!DB.pend) { DB.pend = true; a.addEventListener('blur', () => { DB.pend = false; dbRepaint(); }, { once: true }); }
    return;
  }
  render();
}

// يُستدعى بعد الدخول: الديون التي سجّلتها، والديون التي سجّلها الآخرون عليّ أو لي
function startDebtListeners() {
  stopDebts();
  const u = state.user; if (!u || !state.profile) return;
  const uid = u.uid;
  let asCreator = [], asCounter = [];
  const merge = () => {
    const m = new Map(); [...asCreator, ...asCounter].forEach(x => m.set(x.id, x));
    DB.list = [...m.values()].sort((x, y) => dbTs(y.createdAt) - dbTs(x.createdAt));
    dbNotify(); dbRepaint();
  };
  const warn = code => e => console.warn('الديون: تعذر التحميل', code, e && e.code);
  DB.unsubs.push(db.collection(DB_COL).where('creatorUid', '==', uid).onSnapshot(s => {
    asCreator = s.docs.map(d => ({ id: d.id, ...d.data() })); merge();
  }, warn('creator')));
  DB.unsubs.push(db.collection(DB_COL).where('counterUid', '==', uid).onSnapshot(s => {
    asCounter = s.docs.map(d => ({ id: d.id, ...d.data() })); merge();
  }, warn('counter')));
  // استلاف أُرسل لجوالي وأنا غير مسجّل حينها: نربطه بحسابي الآن
  const myPh = normPhone(state.profile.phone || '');
  if (validPhone(myPh)) {
    DB.unsubs.push(db.collection('loanReqs').doc(myPh).collection('items').onSnapshot(s => {
      s.docs.forEach(x => dbClaimLoan(x.id, myPh));
    }, warn('claim')));
  }
}
// إشعار عند وصول طلب دين جديد لم يُر من قبل
function dbNotify() {
  const me = state.user.uid;
  DB.list.filter(d => (d.status === 'proposed' || d.status === 'requested') && d.counterUid === me).forEach(d => {
    if (DB.seen[d.id]) return;
    DB.seen[d.id] = 1;
    if (d.status === 'requested') pushLocal('طلب استلاف جديد', `${d.creatorName || ''} يطلب منك استلافاً ${fmtNum(dbN(d.amount))} ريال`, 'dbinv_' + d.id);
    else pushLocal('طلب دين جديد', `${d.creatorName || ''} سجّل دَيناً بينكما`, 'dbinv_' + d.id);
  });
}

function dbOpen(id) {
  dbLeave();
  DB.did = id; DB.tab = 'overview'; state.view = 'debt'; render();
  const ref = dbRef(id);
  const gone = () => { if (DB.did !== id) return; dbLeave(); toast('لم يعد هذا الدين متاحاً', 'info'); state.view = 'home'; render(); };
  DB.dUnsubs.push(ref.onSnapshot(d => {
    if (DB.did !== id) return;
    if (!d.exists) return gone();
    DB.d = { id: d.id, ...d.data() }; dbRepaint();
  }, gone));
  DB.dUnsubs.push(ref.collection('payments').onSnapshot(s => {
    if (DB.did !== id) return;
    DB.pays = s.docs.map(x => ({ id: x.id, ...x.data() }))
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || dbTs(b.createdAt) - dbTs(a.createdAt));
    dbRepaint();
  }, () => {}));
}

/* ---------- العرض: الرئيسية ---------- */
function dbCard(d) {
  const me = state.user.uid, lender = dbIsLender(d, me), st = dbStatus(d), left = dbLeft(d);
  const due = !d.dueDate ? 'بدون موعد' : dbDays(dbDay(), d.dueDate) < 0 ? `انتهى ${dbFmt(d.dueDate)}` : `يستحق ${dbFmt(d.dueDate)}`;
  return `<div class="card p-4 space-y-3 cursor-pointer" data-act="db-open" data-id="${esc(d.id)}" role="button" tabindex="0">
    <div class="flex items-start gap-3"><div class="jicon"><i class="fa-solid fa-scale-balanced"></i></div>
      <div class="min-w-0 flex-1"><h4 class="font-black text-sm truncate">${esc(d.counterName)}</h4><p class="text-xs text-slate-500 truncate">${esc(d.reason || 'بدون سبب')}</p></div>
      <div class="flex flex-col items-end gap-1 flex-none"><span class="bdg ${st.c}">${st.l}</span>
        <span class="bdg ${lender ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}">${lender ? 'لك' : 'عليك'}</span></div></div>
    <div class="flex items-end justify-between gap-2"><div><p class="text-[10px] text-slate-500">المتبقي</p>
      <b class="text-lg ${lender ? 'text-emerald-700' : 'text-rose-600'}">${fmtNum(left)} <span class="text-xs">ريال</span></b></div>
      <p class="text-[11px] text-slate-500">${due}</p></div>
    <div class="bar"><i style="width:${dbPct(d)}%"></i></div></div>`;
}
function dbInvitesHtml() {
  const me = state.user.uid, I = DB.list.filter(d => (d.status === 'proposed' || d.status === 'requested') && d.counterUid === me);
  if (!I.length) return '';
  return `<div class="space-y-2"><h3 class="font-black text-sm"><i class="fa-solid fa-envelope-open-text text-amber-500"></i> طلبات بانتظار ردك</h3>
    ${I.map(d => d.status === 'requested'
      ? `<div class="p-4 bg-sky-50 border border-sky-200 rounded-2xl flex flex-wrap justify-between items-center gap-3 text-xs">
        <div class="min-w-0"><p class="font-bold text-sm">${esc(d.creatorName || '')} يطلب منك استلافاً ${fmtNum(d.amount)} ريال</p>
          <p class="text-slate-500">${esc(d.reason || '')}</p>
          <p class="text-slate-500 mt-1">حوّل المبلغ ثم أكّد التحويل، فيثبت القرض على المستلف وتتابعانه من هنا.</p></div>
        <div class="flex flex-wrap gap-2"><button type="button" class="btn b-pri" data-act="db-loan-confirm" data-id="${esc(d.id)}">أكدت التحويل</button>
          <button type="button" class="btn b-red" data-act="db-decline" data-id="${esc(d.id)}">رفض</button></div></div>`
      : `<div class="p-4 bg-amber-50 border border-amber-200 rounded-2xl flex flex-wrap justify-between items-center gap-3 text-xs">
        <div class="min-w-0"><p class="font-bold text-sm">${esc(d.creatorName || '')} ${d.kind === 'lent' ? 'سجّل أنه أقرضك' : 'سجّل أنه اقترض منك'} ${fmtNum(d.amount)} ريال</p>
          <p class="text-slate-500">${esc(d.reason || '')}</p></div>
        <div class="flex gap-2"><button type="button" class="btn b-pri" data-act="db-accept" data-id="${esc(d.id)}">قبول</button>
          <button type="button" class="btn b-red" data-act="db-decline" data-id="${esc(d.id)}">رفض</button></div></div>`).join('')}</div>`;
}
function dbSummaryHtml() {
  const t = dbTotals();
  return `<div class="grid grid-cols-3 gap-2">
    <div class="card p-3 text-center"><p class="text-[10px] text-slate-500">لك عند الآخرين</p><b class="text-sm text-emerald-700">${fmtNum(t.owed)}</b></div>
    <div class="card p-3 text-center"><p class="text-[10px] text-slate-500">عليك للآخرين</p><b class="text-sm text-rose-600">${fmtNum(t.owe)}</b></div>
    <div class="card p-3 text-center"><p class="text-[10px] text-slate-500">ديون متأخرة</p><b class="text-sm ${t.late ? 'text-rose-600' : 'text-slate-800'}">${nf(t.late)}</b></div></div>`;
}
// قسم الديون في الصفحة الرئيسية: عنوان وزر بجواره، ثم الملخص والقائمة
function dbHomeBlock() {
  const me = state.user.uid;
  const L = DB.list.filter(d => !((d.status === 'proposed' || d.status === 'requested') && d.counterUid === me));
  return `<div class="space-y-2.5">
    <div class="sw-sec"><h3>الديون</h3>
      <button type="button" class="sw-add" data-act="go-create-debt"><i class="fa-solid fa-plus"></i> دين جديد</button></div>
    ${L.length ? dbSummaryHtml() : ''}
    ${L.map(dbCard).join('') || '<div class="card p-6 text-center text-xs text-slate-500">لا توجد ديون مسجّلة. سجّل ما لك أو عليك لتتابعه هنا.</div>'}</div>`;
}

/* ---------- العرض: دين جديد ---------- */
// حقول نموذج الدين (تُعرض داخل معالج الإنشاء وتُحفظ عبر dbCreate)
function dbFieldsHtml() {
  const lb = 'text-xs font-semibold block mb-1';
  const opt = (v, t, checked) => `<label class="wz-opt"><input type="radio" name="kind" value="${v}" ${checked ? 'checked' : ''}> <span>${t}</span></label>`;
  return `<div><p class="${lb}" id="wz-kind-l">نوع الدين</p><div class="grid grid-cols-1 gap-2" role="radiogroup" aria-labelledby="wz-kind-l">${opt('lent', 'أنا أقرضت (لي عند الطرف الآخر)', true)}${opt('borrowed', 'أنا اقترضت (عليّ للطرف الآخر)', false)}${opt('loan', 'استلاف: أطلب من شخص مسجّل أن يقرضني (يثبت بعد تأكيده التحويل)', false)}</div></div>
      <div class="grid md:grid-cols-2 gap-3">
        <div><label class="${lb}">اسم الطرف الآخر</label><input name="cname" class="inp" required maxlength="40" placeholder="مثال: خالد"></div>
        <div><label class="${lb}">جواله (إن كان مسجلاً يرى الدين ويقبله، وإجباري في الاستلاف)</label><input name="cphone" class="inp" dir="ltr" placeholder="05xxxxxxxx"></div>
      </div>
      <div class="grid md:grid-cols-2 gap-3">
        <div><label class="${lb}">المبلغ (ريال)</label><input name="amount" type="number" min="0.01" step="any" class="inp" required></div>
        <div><label class="${lb}">سبب الدين</label><input name="reason" class="inp" maxlength="200" placeholder="مثال: إيجار، قرض شخصي"></div>
      </div>
      <div class="grid md:grid-cols-2 gap-3">
        <div><label class="${lb}">تاريخ الدين</label><input name="start" type="date" class="inp" required value="${dbDay()}"></div>
        <div><label class="${lb}">موعد السداد (اختياري)</label><input name="due" type="date" class="inp"></div>
      </div>`;
}
// الواجهة القديمة المستقلة (view=debtNew) صارت تفتح المعالج على نوع «دين»
function dbNewView() { if (state.createType !== 'debt') { state.createType = 'debt'; wzS().step = 2; } return wzView(); }
const loanReqRef = (phone, did) => db.collection('loanReqs').doc(phone).collection('items').doc(did);
function loanReqText(name, amount, reason) {
  return `السلام عليكم ${name || ''}،\nأطلب منك استلاف ${fmtNum(amount)} ريال${reason ? ' — ' + reason : ''}.\nإن وافقت فحوّل المبلغ، ثم أكّد التحويل في التطبيق ليُسجَّل القرض بعد تأكيدك. شكراً لك.`;
}
async function dbCreate(f) {
  const choice = f.kind.value, isLoan = choice === 'loan', kind = isLoan ? 'borrowed' : choice;
  const name = f.cname.value.trim(), rawPhone = f.cphone.value.trim();
  const phone = rawPhone ? normPhone(rawPhone) : '';
  const amount = r2(parseFloat(f.amount.value)), reason = f.reason.value.trim(), start = f.start.value, due = f.due.value || '';
  if (name.length < 2) return toast('اكتب اسم الطرف الآخر', 'error');
  if (rawPhone && !validPhone(phone)) return toast('الجوال يجب أن يبدأ بـ 05 ويتكون من 10 أرقام', 'error');
  if (isLoan && !phone) return toast('أدخل جوال المُقرض ليصله الطلب ورابط التسجيل', 'error');
  if (phone && phone === normPhone(state.profile.phone)) return toast('لا يمكن تسجيل دين على نفسك', 'error');
  if (!(amount > 0)) return toast('المبلغ غير صحيح', 'error');
  if (!dbDateOk(start) || (due && (!dbDateOk(due) || due < start))) return toast('تحقق من التواريخ', 'error');
  let counterUid = '';
  if (phone) {
    const ps = await db.collection('phones').doc(phone).get().catch(() => null);
    if (ps && ps.exists && ps.data().uid && ps.data().uid !== state.user.uid) counterUid = ps.data().uid;
  }
  const data = {
    creatorUid: state.user.uid, creatorName: dispName(state.profile).slice(0, 60), kind,
    counterName: name.slice(0, 40), counterPhone: phone, counterUid, amount, reason: reason.slice(0, 200),
    startDate: start, dueDate: due,
    status: isLoan ? 'requested' : (counterUid ? 'proposed' : 'open'), paid: 0,
    createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp()
  };
  if (isLoan) data.type = 'loan';
  try {
    const nref = db.collection(DB_COL).doc(), b = db.batch();
    b.set(nref, data);
    // المُقرض غير مسجّل: نفهرس الطلب بجواله ليظهر له بعد التسجيل
    if (isLoan && !counterUid) b.set(loanReqRef(phone, nref.id), { debtId: nref.id, creatorUid: state.user.uid, creatorName: data.creatorName, amount, reason: data.reason, createdAt: FV.serverTimestamp() });
    await b.commit();
    if (isLoan && !counterUid) {
      wzS().data.debt = {}; wzDraftClear(); state.view = 'home'; render();
      showModal('أُرسل طلب الاستلاف', `<div class="space-y-3 text-sm">
        <p class="text-xs text-slate-600 leading-relaxed">المُقرض غير مسجّل بعد. أرسل له الطلب عبر واتساب، وفيه رابط التسجيل. سيظهر الطلب له بعد تسجيله بنفس الجوال.</p>
        <a class="btn b-pri w-full" target="_blank" rel="noopener" href="${waLink(phone, loanReqText(data.counterName, amount, reason))}"><i class="fa-brands fa-whatsapp"></i> إرسال الطلب عبر واتساب</a></div>`);
      return;
    }
    toast(isLoan ? 'أُرسل طلب الاستلاف للمُقرض' : counterUid ? 'أُرسل الدين للطرف الآخر ليقبله' : 'سُجّل الدين', 'info');
    if (counterUid) sendNotifs([counterUid], isLoan ? 'طلب استلاف جديد' : 'طلب دين جديد',
      isLoan ? `${data.creatorName} يطلب منك استلافاً ${fmtNum(amount)} ريال` : `${data.creatorName} سجّل دَيناً بينكما بمبلغ ${fmtNum(amount)} ريال`,
      dbJid(nref.id), 'debt', 'dbinv_' + nref.id);
    wzDone('debt', nref.id, name);
  } catch (e) { toast('تعذر الحفظ: ' + e.message, 'error'); }
}

/* ---------- العرض: تفاصيل الدين ---------- */
function dbView() {
  const d = DB.d; if (!d) return vLoading();
  const me = state.user.uid, lender = dbIsLender(d, me), st = dbStatus(d), left = dbLeft(d);
  const isProposed = d.status === 'proposed', isRequested = d.status === 'requested';
  const canPay = d.status === 'open' && left > 0;
  const pendingN = lender ? DB.pays.filter(p => p.status === 'pending').length : 0;
  const payBtn = canPay ? `<button type="button" class="btn b-white" data-act="db-pay-modal"><i class="fa-solid ${lender ? 'fa-hand-holding-dollar' : 'fa-money-bill-transfer'}"></i> ${lender ? 'تسجيل مبلغ مستلم' : 'سددت مبلغاً'}</button>` : '';
  const hero = `<div class="rounded-3xl p-5 text-white shadow-lg space-y-4" style="background:linear-gradient(135deg,#9a3412,#d97706 55%,#fbbf24)">
    <div class="flex justify-between items-start gap-3"><div class="min-w-0"><p class="text-[11px] text-amber-100 font-bold">${lender ? 'لك على' : 'عليك لـ'}</p>
      <h3 class="text-xl font-black truncate">${esc(d.counterName)}</h3>${d.reason ? `<p class="text-xs text-amber-50/90 mt-1">${esc(d.reason)}</p>` : ''}</div>
      <span class="flex-none px-2.5 py-1 rounded-full text-[10px] font-black bg-white/25">${st.l}</span></div>
    <div><p class="text-[11px] text-amber-100">المتبقي</p><p class="text-3xl font-black">${fmtNum(left)} <span class="text-sm opacity-80">ريال</span></p>
      <div class="h-2.5 rounded-full bg-white/25 overflow-hidden mt-2"><div class="h-full rounded-full bg-white" style="width:${dbPct(d)}%"></div></div>
      <p class="text-[11px] text-amber-50 mt-1">سُدّد ${fmtNum(dbN(d.paid))} من ${fmtNum(d.amount)} ريال</p></div>
    ${isProposed ? `<div class="rounded-2xl bg-white/15 p-3 text-center text-xs font-bold">بانتظار قبول ${esc(d.counterName)} لهذا الدين</div>` : ''}
    ${isRequested ? (lender ? `<div class="grid grid-cols-2 gap-2"><button type="button" class="btn b-white" data-act="db-loan-confirm" data-id="${esc(d.id)}"><i class="fa-solid fa-circle-check"></i> أكدت التحويل</button><button type="button" class="btn b-red" data-act="db-decline" data-id="${esc(d.id)}">رفض الطلب</button></div>` : `<div class="rounded-2xl bg-white/15 p-3 text-center text-xs font-bold">بانتظار أن يحوّل ${esc(d.counterName)} المبلغ ويؤكد التحويل هنا</div>${!d.counterUid && d.counterPhone ? `<a class="btn b-white w-full" target="_blank" rel="noopener" href="${waLink(d.counterPhone, loanReqText(d.counterName, d.amount, d.reason))}"><i class="fa-brands fa-whatsapp"></i> إعادة إرسال الطلب عبر واتساب</a>` : ''}`) : ''}
    ${payBtn}
  </div>`;

  const tabs = [['overview', 'fa-house', 'الرئيسية', 0], ['payments', 'fa-receipt', 'الدفعات', pendingN], ['more', 'fa-ellipsis', 'المزيد', 0]];
  const bar = `<div class="grid grid-cols-3 gap-1.5 p-1.5 bg-white/95 backdrop-blur rounded-2xl border border-slate-100 shadow-sm sticky top-2 z-10">${tabs.map(([k, ic, lb, n]) => `<button type="button" class="relative py-2 rounded-xl text-[11px] font-bold flex flex-col items-center gap-0.5 ${DB.tab === k ? 'bg-amber-600 text-white' : 'text-slate-500'}" data-act="db-tab" data-v="${k}"><i class="fa-solid ${ic}"></i>${lb}${n ? `<span class="absolute -top-1 -left-1 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] flex items-center justify-center">${n}</span>` : ''}</button>`).join('')}</div>`;

  const body = DB.tab === 'payments' ? dbPaymentsTab(d, lender)
    : DB.tab === 'more' ? dbMoreTab(d, lender)
    : dbOverviewTab(d, lender, st, left);

  return `<div class="space-y-4 max-w-2xl mx-auto">
    <div class="flex items-center gap-3"><button type="button" class="w-10 h-10 rounded-xl bg-white border border-slate-200 flex-none" data-act="go-home" aria-label="رجوع"><i class="fa-solid fa-arrow-right"></i></button>
      <div class="jicon"><i class="fa-solid fa-scale-balanced"></i></div>
      <div class="min-w-0"><h2 class="font-black text-lg truncate">${esc(d.counterName)}</h2><p class="text-[11px] text-slate-500 truncate"><span class="text-amber-700 font-bold">${d.type === 'loan' ? 'استلاف' : 'دين'}</span> • ${fmtNum(d.amount)} ريال</p></div></div>
    ${bar}${hero}${body}</div>`;
}
function dbOverviewTab(d, lender, st, left) {
  const dueLine = !d.dueDate ? 'بدون موعد سداد' : (() => {
    const n = dbDays(dbDay(), d.dueDate);
    return n < 0 ? `انتهى الموعد (${dbFmt(d.dueDate)})` : n === 0 ? `اليوم آخر يوم (${dbFmt(d.dueDate)})` : `متبقي ${n} يوم (${dbFmt(d.dueDate)})`;
  })();
  const contact = d.counterPhone ? `<div class="flex items-center justify-between gap-2 p-3 bg-slate-50 rounded-xl"><div class="min-w-0"><p class="text-[10px] text-slate-500">جوال ${esc(d.counterName)}</p><b class="text-xs block" dir="ltr">${esc(d.counterPhone)}</b></div>
    <button type="button" data-act="qt-copy-text" data-v="${esc(d.counterPhone)}" class="flex-none px-2 py-1 rounded-lg bg-white border border-slate-200 text-[11px] font-bold text-teal-700"><i class="fa-regular fa-copy"></i> نسخ</button></div>` : '';
  const remind = lender && d.counterPhone && left > 0 && d.status === 'open'
    ? `<a href="${waLink(d.counterPhone, `السلام عليكم ${d.counterName}،\nتذكير بالمبلغ المتبقي ${fmtNum(left)} ريال${d.reason ? ' عن ' + d.reason : ''}. شكراً لك.`)}" target="_blank" rel="noopener" class="btn bg-emerald-50 text-emerald-700 w-full"><i class="fa-brands fa-whatsapp"></i> تذكير عبر واتساب</a>` : '';
  return dbBox('<i class="fa-solid fa-lightbulb text-amber-500"></i> الحالة', `<p class="text-xs text-slate-600 leading-relaxed">${dbAdvice(d, lender, st, left)}</p>${remind}`)
    + dbBox('<i class="fa-solid fa-calendar-days text-amber-600"></i> التواريخ', `<div class="grid grid-cols-2 gap-2">${dbTile('تاريخ الدين', dbFmt(d.startDate))}${dbTile('موعد السداد', esc(dueLine))}</div>`)
    + dbBox('<i class="fa-solid fa-circle-info text-amber-600"></i> التفاصيل', `<div class="grid grid-cols-2 gap-2">${dbTile('المبلغ الأصلي', fmtNum(d.amount) + ' ريال')}${dbTile('المسدّد', fmtNum(d.paid) + ' ريال', 'text-emerald-700')}${dbTile('المتبقي', fmtNum(left) + ' ريال', left ? 'text-rose-600' : 'text-emerald-700')}${dbTile(lender ? 'المدين' : 'الدائن', esc(d.counterName))}${dbTile('سجّله', esc(d.creatorName || '—'))}${dbTile('نوع الدين', lender ? 'لي عند الطرف الآخر' : 'عليّ للطرف الآخر')}</div>${contact}`);
}
function dbAdvice(d, lender, st, left) {
  switch (st.k) {
    case 'proposed': return `بانتظار أن يقبل ${esc(d.counterName)} الدين. لن يُحتسب قبل القبول.`;
    case 'requested': if (!d.counterUid && !lender) return `أرسلنا الطلب إلى ${esc(d.counterName)} عبر واتساب مع رابط التسجيل. سيظهر له الطلب بعد تسجيله بنفس الجوال، ثم يحوّل المبلغ ويؤكد التحويل.`; return lender ? `طلب ${esc(d.creatorName || '')} استلافاً ${fmtNum(d.amount)} ريال. حوّل المبلغ ثم أكّد التحويل، فيثبت القرض عليه وتتابعه هنا.` : `بانتظار أن يحوّل ${esc(d.counterName)} المبلغ ويؤكد التحويل. لن يُحتسب القرض قبل ذلك.`;
    case 'declined': return `رفض ${esc(d.counterName)} هذا الدين.`;
    case 'closed': return left > 0 ? 'أُغلق الدين وأُعفي من المتبقي.' : 'تم سداد الدين بالكامل.';
    case 'late': return lender ? `تجاوز موعد السداد. المتبقي ${fmtNum(left)} ريال، يمكنك التذكير به.` : `تجاوز موعد السداد. المتبقي عليك ${fmtNum(left)} ريال، سدّده في أقرب وقت.`;
    default: return lender ? `المتبقي ${fmtNum(left)} ريال. تُحسب الدفعة عند تسجيلها أو تأكيدك لها.` : `المتبقي عليك ${fmtNum(left)} ريال. سجّل كل دفعة تسددها.`;
  }
}
function dbPaymentsTab(d, lender) {
  const me = state.user.uid;
  const pend = DB.pays.filter(p => p.status === 'pending');
  const pendHtml = pend.map(p => {
    const mine = p.byUid === me;
    const acts = lender
      ? `<button type="button" class="btn bg-emerald-600 text-white" data-act="db-pay-ok" data-id="${esc(p.id)}"><i class="fa-solid fa-check"></i> تأكيد</button><button type="button" class="btn b-red" data-act="db-pay-no" data-id="${esc(p.id)}">رفض</button>`
      : mine ? `<button type="button" class="btn b-red" data-act="db-pay-cancel" data-id="${esc(p.id)}">إلغاء</button>` : '';
    return `<div class="p-3 bg-sky-50 border border-sky-100 rounded-xl text-xs flex flex-wrap justify-between items-center gap-2">
      <div class="min-w-0"><p class="font-bold">${fmtNum(p.amount)} ريال • ${dbFmt(p.date)}</p><p class="text-[10px] text-slate-500">سجّله ${esc(p.byName || '')}${p.note ? ' • ' + esc(p.note) : ''}</p></div>
      <div class="flex gap-1.5">${acts}</div></div>`;
  }).join('');
  const all = DB.pays.map(p => {
    const [lb, cl] = p.status === 'confirmed' ? ['مؤكدة', 'bg-emerald-100 text-emerald-700'] : p.status === 'pending' ? ['بانتظار التأكيد', 'bg-sky-100 text-sky-700'] : ['مرفوضة', 'bg-rose-100 text-rose-700'];
    const undo = lender && p.status === 'confirmed' && d.status !== 'proposed'
      ? `<button type="button" class="px-2 py-1 bg-rose-50 text-rose-600 rounded-lg" data-act="db-pay-undo" data-id="${esc(p.id)}" aria-label="التراجع عن الدفعة"><i class="fa-solid fa-rotate-left"></i></button>` : '';
    return `<div class="p-3 bg-slate-50 border border-slate-100 rounded-xl flex justify-between items-center gap-2 text-xs">
      <div class="min-w-0"><p class="font-bold">${fmtNum(p.amount)} ريال</p><p class="text-[10px] text-slate-500">${dbFmt(p.date)} • ${esc(p.byName || '')}${p.note ? ' • ' + esc(p.note) : ''}</p></div>
      <div class="flex items-center gap-2"><span class="px-2 py-1 rounded-lg font-bold ${cl}">${lb}</span>${undo}</div></div>`;
  }).join('');
  return (pend.length ? dbBox('<i class="fa-solid fa-clock text-sky-600"></i> دفعات بانتظار التأكيد', `<div class="space-y-2">${pendHtml}</div>`) : '')
    + dbBox('<i class="fa-solid fa-list text-slate-500"></i> سجل الدفعات', `<div class="space-y-2">${all || dbEmpty('لا توجد دفعات مسجّلة بعد')}</div>`);
}
function dbMoreTab(d, lender) {
  const canEdit = d.creatorUid === state.user.uid && dbN(d.paid) === 0;
  const parts = [];
  if (canEdit) parts.push(`<button type="button" class="btn b-sec" data-act="db-edit-modal"><i class="fa-solid fa-pen"></i> تعديل الدين</button>`);
  if (lender && d.status === 'open') parts.push(`<button type="button" class="btn b-sec" data-act="db-close"><i class="fa-solid fa-hand-holding-heart"></i> إعفاء المتبقي وإغلاق الدين</button>`);
  if (lender && d.status === 'closed') parts.push(`<button type="button" class="btn b-sec" data-act="db-reopen"><i class="fa-solid fa-lock-open"></i> إعادة فتح الدين</button>`);
  if (d.creatorUid === state.user.uid && dbN(d.paid) === 0) parts.push(`<button type="button" class="btn b-red" data-act="db-delete"><i class="fa-solid fa-trash"></i> حذف الدين</button>`);
  return dbBox('<i class="fa-solid fa-sliders text-indigo-600"></i> إجراءات', parts.length
    ? `<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">${parts.join('')}</div>`
    : '<p class="text-xs text-slate-500 leading-relaxed">لا توجد إجراءات متاحة الآن. يمكن تعديل الدين أو حذفه قبل تسجيل أي دفعة عليه.</p>');
}

/* ---------- الدفعات ---------- */
function dbOpenPay() {
  const d = DB.d; if (!d) return;
  const left = dbLeft(d), lender = dbIsLender(d, state.user.uid);
  const note = !lender && d.counterUid ? 'ستُرسل للدائن ليؤكدها.' : '';
  showModal(lender ? 'تسجيل مبلغ مستلم' : 'تسجيل مبلغ مسدَّد', `<form id="f-db-pay" class="space-y-3">
    <p class="text-xs text-slate-500">المتبقي ${fmtNum(left)} ريال. ${note}</p>
    <div><label class="text-xs font-semibold block mb-1">المبلغ (ريال)</label><input name="pamount" type="number" min="0.01" max="${left}" step="any" class="inp" required></div>
    <div><label class="text-xs font-semibold block mb-1">التاريخ</label><input name="pdate" type="date" class="inp" required value="${dbDay()}"></div>
    <div><label class="text-xs font-semibold block mb-1">ملاحظة (اختياري)</label><input name="pnote" class="inp" maxlength="120"></div>
    <button class="btn b-pri w-full py-3" type="submit">حفظ</button></form>`);
}
// يُضيف دفعة ويحدّث المسدّد. الدفعة المؤكدة تغلق الدين تلقائياً عند اكتمال المبلغ
function dbApplyPaid(b, ref, d, delta) {
  const upd = { paid: FV.increment(delta), updatedAt: FV.serverTimestamp() };
  if (delta > 0 && r2(dbN(d.paid) + delta) >= dbN(d.amount)) upd.status = 'closed';
  if (delta < 0 && d.status === 'closed') upd.status = 'open';
  b.update(ref, upd);
}
async function dbSavePay(f) {
  const d = DB.d; if (!d) return;
  const me = state.user.uid, amount = r2(parseFloat(f.pamount.value)), date = f.pdate.value, note = f.pnote.value.trim();
  const left = dbLeft(d);
  if (!(amount > 0) || amount > left) return toast(`المبلغ يجب أن يكون بين 0.01 و ${fmtNum(left)}`, 'error');
  if (!dbDateOk(date)) return toast('حدد التاريخ', 'error');
  const lender = dbIsLender(d, me);
  const confirmed = lender || !d.counterUid; // الدائن يؤكد مباشرة، والمدين مع دائن غير مسجّل يسجّل مباشرة
  const ref = dbRef(d.id), b = db.batch();
  b.set(ref.collection('payments').doc(), {
    amount, date, note: note.slice(0, 120), byUid: me, byName: dispName(state.profile).slice(0, 60),
    status: confirmed ? 'confirmed' : 'pending', createdAt: FV.serverTimestamp()
  });
  if (confirmed) dbApplyPaid(b, ref, d, amount);
  try { await b.commit(); closeModal(); toast(confirmed ? 'سُجّل المبلغ' : 'أُرسلت الدفعة للدائن للتأكيد'); const o = dbOther(d); if (o) sendNotifs([o], confirmed ? 'سُجّلت دفعة على الدين' : 'دفعة جديدة بانتظار تأكيدك', `${dispName(state.profile)} — ${fmtNum(amount)} ريال`, dbJid(d.id), 'debt'); }
  catch (e) { toast('تعذر الحفظ: ' + e.message, 'error'); }
}
async function dbDecidePay(pid, ok) {
  const d = DB.d, p = DB.pays.find(x => x.id === pid);
  if (!d || !p || p.status !== 'pending' || !dbIsLender(d, state.user.uid)) return;
  if (ok && dbN(p.amount) > dbLeft(d)) return toast('المبلغ أكبر من المتبقي، ارفض الدفعة أو عدّل الدين', 'error');
  const ref = dbRef(d.id), b = db.batch();
  b.update(ref.collection('payments').doc(pid), { status: ok ? 'confirmed' : 'rejected', decidedAt: FV.serverTimestamp() });
  if (ok) dbApplyPaid(b, ref, d, dbN(p.amount));
  try { await b.commit(); toast(ok ? 'تم تأكيد الدفعة' : 'رُفضت الدفعة', 'info'); if (p.byUid) sendNotifs([p.byUid], ok ? 'تم تأكيد دفعتك ✓' : 'لم تُقبل دفعتك', `${fmtNum(dbN(p.amount))} ريال — ${dispName(state.profile)}`, dbJid(d.id), 'debt'); }
  catch (e) { toast('تعذر الحفظ: ' + e.message, 'error'); }
}
async function dbUndoPay(pid) {
  const d = DB.d, p = DB.pays.find(x => x.id === pid);
  if (!d || !p || p.status !== 'confirmed' || !dbIsLender(d, state.user.uid)) return;
  if (!confirm('التراجع عن هذه الدفعة؟ سينقص المبلغ من المسدّد.')) return;
  const ref = dbRef(d.id), b = db.batch();
  b.delete(ref.collection('payments').doc(pid));
  dbApplyPaid(b, ref, d, -dbN(p.amount));
  try { await b.commit(); toast('أُلغيت الدفعة', 'info'); }
  catch (e) { toast('تعذر التراجع: ' + e.message, 'error'); }
}
async function dbCancelPay(pid) {
  const d = DB.d; if (!d) return;
  if (!confirm('إلغاء هذه الدفعة المعلّقة؟')) return;
  try { await dbRef(d.id).collection('payments').doc(pid).delete(); toast('أُلغيت الدفعة', 'info'); }
  catch (e) { toast('تعذر الإلغاء: ' + e.message, 'error'); }
}

/* ---------- القبول والرفض والإدارة ---------- */
const dbClaiming = new Set();
async function dbClaimLoan(did, myPh) {
  if (dbClaiming.has(did)) return; dbClaiming.add(did);
  const b = db.batch();
  b.update(dbRef(did), { counterUid: state.user.uid, updatedAt: FV.serverTimestamp() });
  b.delete(loanReqRef(myPh, did));
  try { await b.commit(); }
  catch (e) {
    // الطلب حُذف من المُستلف: نحذف الفهرس وحده
    if (e && e.code === 'not-found') await loanReqRef(myPh, did).delete().catch(() => {});
    else console.warn('الديون: تعذر ربط الاستلاف', e && e.code);
  } finally { dbClaiming.delete(did); }
}
async function dbRespond(id, status) {
  try { await dbRef(id).update({ status, updatedAt: FV.serverTimestamp() }); toast(status === 'open' ? 'تم قبول الدين' : 'تم رفض الدين', 'info'); const dd = DB.list.find(x => x.id === id); if (dd) sendNotifs([dd.creatorUid], status === 'open' ? 'قُبل الدين ✓' : 'رُفض الدين', `${dispName(state.profile)} ${status === 'open' ? 'قبل' : 'رفض'} الدين المسجّل بمبلغ ${fmtNum(dbN(dd.amount))} ريال`, dbJid(id), 'debt'); }
  catch (e) { toast('تعذر التحديث: ' + e.message, 'error'); }
}
async function dbSetClosed(closed) {
  const d = DB.d; if (!d || !dbIsLender(d, state.user.uid)) return;
  if (closed && !confirm('إغلاق الدين وإعفاء الطرف الآخر من المتبقي؟')) return;
  try { await dbRef(d.id).update({ status: closed ? 'closed' : 'open', updatedAt: FV.serverTimestamp() }); toast(closed ? 'أُغلق الدين' : 'أُعيد فتح الدين', 'info'); const o = dbOther(d); if (o) sendNotifs([o], closed ? 'أُغلق الدين' : 'أُعيد فتح الدين', `${dispName(state.profile)} — ${fmtNum(dbN(d.amount))} ريال`, dbJid(d.id), 'debt'); }
  catch (e) { toast('تعذر التحديث: ' + e.message, 'error'); }
}
function dbOpenEdit() {
  const d = DB.d; if (!d || d.creatorUid !== state.user.uid || dbN(d.paid) > 0) return;
  const lb = 'text-xs font-semibold block mb-1';
  showModal('تعديل الدين', `<form id="f-db-edit" class="space-y-3">
    <div><label class="${lb}">اسم الطرف الآخر</label><input name="ename" class="inp" required maxlength="40" value="${esc(d.counterName)}"></div>
    <div><label class="${lb}">المبلغ (ريال)</label><input name="eamount" type="number" min="0.01" step="any" class="inp" required value="${dbN(d.amount)}"></div>
    <div><label class="${lb}">سبب الدين</label><input name="ereason" class="inp" maxlength="200" value="${esc(d.reason || '')}"></div>
    <div><label class="${lb}">موعد السداد (اختياري)</label><input name="edue" type="date" class="inp" value="${esc(d.dueDate || '')}"></div>
    <button class="btn b-pri w-full py-3" type="submit">حفظ</button></form>`);
}
async function dbEditSave(f) {
  const d = DB.d; if (!d) return;
  const name = f.ename.value.trim(), amount = r2(parseFloat(f.eamount.value)), reason = f.ereason.value.trim(), due = f.edue.value || '';
  if (name.length < 2) return toast('اكتب اسم الطرف الآخر', 'error');
  if (!(amount > 0)) return toast('المبلغ غير صحيح', 'error');
  if (due && (!dbDateOk(due) || due < d.startDate)) return toast('موعد السداد يجب ألا يسبق تاريخ الدين', 'error');
  try { await dbRef(d.id).update({ counterName: name, amount, reason: reason.slice(0, 200), dueDate: due, updatedAt: FV.serverTimestamp() }); closeModal(); toast('حُفظ التعديل'); }
  catch (e) { toast('تعذر الحفظ: ' + e.message, 'error'); }
}
async function dbDelete() {
  const d = DB.d; if (!d || d.creatorUid !== state.user.uid || dbN(d.paid) > 0) return;
  if (!confirm('حذف هذا الدين نهائياً؟')) return;
  try {
    const ref = dbRef(d.id), pays = await ref.collection('payments').get();
    const refs = [...pays.docs.map(x => x.ref), ref];
    if (d.type === 'loan' && !d.counterUid && d.counterPhone) refs.push(loanReqRef(normPhone(d.counterPhone), d.id));
    for (let i = 0; i < refs.length; i += 400) { const b = db.batch(); refs.slice(i, i + 400).forEach(r => b.delete(r)); await b.commit(); }
    dbLeave(); state.view = 'home'; render(); toast('حُذف الدين', 'info');
  } catch (e) { toast('تعذر الحذف: ' + e.message, 'error'); }
}

/* ---------- استلاف: تأكيد التحويل ---------- */
// المُقرض يؤكد أنه حوّل المبلغ، فيثبت القرض على المُستلف بالمبلغ والتاريخ الفعليين
function dbLoanOf(id) {
  const d = DB.list.find(x => x.id === id) || (DB.d && DB.d.id === id ? DB.d : null);
  return d && d.status === 'requested' && d.counterUid === state.user.uid ? d : null;
}
function dbOpenLoanConfirm(id) {
  const d = dbLoanOf(id); if (!d) return toast('هذا الطلب لم يعد متاحاً', 'error');
  DB.confirmId = id;
  const lb = 'text-xs font-semibold block mb-1';
  showModal('تأكيد تحويل المبلغ', `<form id="f-db-loan" class="space-y-3">
    <p class="text-xs text-slate-500">سيثبت القرض على ${esc(d.creatorName || '')} بهذا المبلغ، وتتابعان السداد من هنا.</p>
    <div><label class="${lb}">المبلغ المحوَّل (ريال)</label><input name="lamount" type="number" min="0.01" max="100000000" step="any" class="inp" required value="${dbN(d.amount)}"></div>
    <div><label class="${lb}">تاريخ التحويل</label><input name="ldate" type="date" class="inp" required value="${dbDay()}"></div>
    <button class="btn b-pri w-full py-3" type="submit">تأكيد وإثبات القرض</button></form>`);
}
async function dbSaveLoanConfirm(f) {
  const d = dbLoanOf(DB.confirmId); if (!d) return toast('هذا الطلب لم يعد متاحاً', 'error');
  const amount = r2(parseFloat(f.lamount.value)), date = f.ldate.value;
  if (!(amount > 0) || amount > 100000000) return toast('المبلغ غير صحيح', 'error');
  if (!dbDateOk(date)) return toast('حدد تاريخ التحويل', 'error');
  try {
    await dbRef(d.id).update({ status: 'open', amount, startDate: date, paid: 0, updatedAt: FV.serverTimestamp() });
    closeModal(); toast('تم إثبات القرض على المستلف');
    sendNotifs([d.creatorUid], 'تم تحويل القرض ✓', `${dispName(state.profile)} حوّل ${fmtNum(amount)} ريال وأكّد القرض`, dbJid(d.id), 'debt');
  } catch (e) { toast('تعذر التأكيد: ' + e.message, 'error'); }
}

/* ---------- الربط بالتطبيق الرئيسي ---------- */
const DB_ACTIONS = {
  'go-create-debt': () => { dbLeave(); wzStart('debt'); },
  'db-open': el => dbOpen(el.dataset.id),
  'db-tab': el => { DB.tab = el.dataset.v; render(); window.scrollTo({ top: 0 }); },
  'db-accept': el => dbRespond(el.dataset.id, 'open'),
  'db-decline': el => dbRespond(el.dataset.id, 'declined'),
  'db-pay-modal': () => dbOpenPay(),
  'db-pay-ok': el => dbDecidePay(el.dataset.id, true),
  'db-pay-no': el => dbDecidePay(el.dataset.id, false),
  'db-pay-undo': el => dbUndoPay(el.dataset.id),
  'db-pay-cancel': el => dbCancelPay(el.dataset.id),
  'db-close': () => dbSetClosed(true),
  'db-reopen': () => dbSetClosed(false),
  'db-edit-modal': () => dbOpenEdit(),
  'db-delete': () => dbDelete(),
  'db-loan-confirm': el => dbOpenLoanConfirm(el.dataset.id)
};
const DB_FORMS = {
  'f-db-new': f => needVerified(() => dbCreate(f)),
  'f-db-pay': dbSavePay,
  'f-db-edit': dbEditSave,
  'f-db-loan': dbSaveLoanConfirm
};
