/* ============ القطة: صندوق مشترك لجمع مبلغ لفعالية أو رحلة ============
   وحدة مستقلة تعتمد على متغيّرات التطبيق الرئيسي (state, db, FV, render, toast, ...).
   تُحمَّل قبل السكربت الرئيسي في index.html، ويُدمج QT_ACTIONS و QT_FORMS في الرئيسي.

   هيكل البيانات:
     qattahs/{qid}                  الوثيقة: الاسم والسبب والهدف والتواريخ، والمشرف والنائب،
                                    memberUids (للاستعلام)، collected (مجموع المدفوع، يُحدَّث بـ increment)
     qattahs/{qid}/members/{uid}    المشاركون: الاسم، الجوال، المدفوع
     qattahs/{qid}/expenses/{eid}   المصروفات
     qattahInvites/{qid}__p{جوال}   دعوات بانتظار القبول (أو {qid}__{بريد})
*/

const QT = { list: [], invites: [], q: null, qid: null, members: [], expenses: [], invAdmin: [], invFor: null, tab: 'overview', unsubs: [], dUnsubs: [], seen: {}, pend: false, shareText: '' };
const QT_COL = 'qattahs', QT_INV = 'qattahInvites';

/* ---------- أدوات مساعدة ---------- */
const qtRef = id => db.collection(QT_COL).doc(id);
const qtDay = () => isoDay(new Date());
const qtDateOk = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const qtFmtDate = s => qtDateOk(s) ? new Date(s + 'T12:00:00').toLocaleDateString(LOCD(), { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const qtNum = v => Number(v) || 0;
const qtShare = q => q && qtNum(q.participants) > 0 ? r2(qtNum(q.target) / qtNum(q.participants)) : 0;
const qtPct = (num, den) => den > 0 ? Math.max(0, Math.min(100, Math.round(num / den * 100))) : 0;
const qtAdminOf = q => !!q && !!state.user && q.adminUid === state.user.uid;
const qtStaffOf = q => !!q && !!state.user && (q.adminUid === state.user.uid || (!!q.deputyUid && q.deputyUid === state.user.uid));
const qtUnlocked = q => qtNum(q.collected) >= qtNum(q.target) || !!q.expOpen;
const qtTs = v => { const d = v && v.toDate ? v.toDate() : null; return d ? d.getTime() : 0; };
const qtDaysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / DAY_MS);
const qtMemberDoc = (uid, name, phone, direct) => ({ uid, name, phone: phone || '', paid: 0, direct: !!direct, addedBy: state.user.uid, joinedAt: FV.serverTimestamp() });

/* الحالة المرئية للقطة: تُحسب من التواريخ والمبلغ المحصّل */
function qtStatus(q) {
  const t = qtDay(), c = qtNum(q.collected), tg = qtNum(q.target);
  if (t > q.eventEnd) return { k: 'done', l: 'مكتملة', c: 'bg-slate-100 text-slate-600', i: 'fa-flag-checkered' };
  if (t >= q.eventStart) return { k: 'ongoing', l: 'فعالية جارية', c: 'bg-sky-100 text-sky-700', i: 'fa-plane-departure' };
  if (c >= tg) return { k: 'funded', l: 'اكتمل المبلغ', c: 'bg-emerald-100 text-emerald-700', i: 'fa-circle-check' };
  if (t < q.collectStart) return { k: 'soon', l: 'لم يبدأ الجمع', c: 'bg-slate-100 text-slate-600', i: 'fa-hourglass-start' };
  if (t <= q.collectEnd) return { k: 'collecting', l: 'قيد الجمع', c: 'bg-amber-100 text-amber-700', i: 'fa-coins' };
  return { k: 'late', l: 'لم يكتمل الجمع', c: 'bg-rose-100 text-rose-700', i: 'fa-circle-exclamation' };
}

function qtAdvice(q, st) {
  const rem = Math.max(0, qtNum(q.target) - qtNum(q.collected));
  switch (st.k) {
    case 'soon': return `يبدأ الجمع في ${qtFmtDate(q.collectStart)}.`;
    case 'collecting': return `متبقٍ ${fmtNum(rem)} ريال للهدف. ذكّر من لم يسدد من تبويب المشاركين.`;
    case 'funded': return 'اكتمل المبلغ المستهدف، وأصبحت المصروفات مفتوحة للمشرف والنائب.';
    case 'ongoing': return 'الفعالية جارية الآن. سجّل المصروفات أولاً بأول لتبقى الأرقام واضحة.';
    case 'done': return 'انتهت الفعالية. راجع المصروفات والمتبقي.';
    default: return 'انتهى موعد الجمع دون اكتمال الهدف. يمكن للمشرف تعديل الهدف أو المدة.';
  }
}

const qtInviteText = o => `السلام عليكم ${o.name || ''}،\nدعاك ${o.admin || ''} للمشاركة في القطة «${o.qName}».\nالهدف: ${fmtNum(o.target)} ريال • حصتك: ${fmtNum(o.share)} ريال\nللمشاركة افتح التطبيق ووافق على الدعوة من الصفحة الرئيسية:\n${appUrl()}`;
const qtRemindText = (q, m, due) => `السلام عليكم ${m.name || ''}،\nتذكير بمساهمتك في القطة «${q.name}»، المتبقي عليك ${fmtNum(due)} ريال.\nشكراً لتعاونك 🌿`;

/* ---------- الاشتراك في البيانات ---------- */
function qtLeave() {
  QT.dUnsubs.forEach(u => u()); QT.dUnsubs = [];
  QT.q = null; QT.qid = null; QT.members = []; QT.expenses = []; QT.invAdmin = []; QT.invFor = null;
}
function stopQattah() {
  QT.unsubs.forEach(u => u()); QT.unsubs = [];
  qtLeave(); QT.list = []; QT.invites = []; QT.seen = {};
}
// إعادة الرسم بعد كل تحديث، مع تأجيل الرسم إن كان المستخدم يكتب في حقل داخل الصفحة حتى لا يضيع ما كتبه
function qtRepaint() {
  if (!['home', 'qattah'].includes(state.view)) return;
  const a = document.activeElement;
  if (a && a.closest && a.closest('#app') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) {
    if (!QT.pend) { QT.pend = true; a.addEventListener('blur', () => { QT.pend = false; qtRepaint(); }, { once: true }); }
    return;
  }
  render();
}

// يُستدعى بعد تسجيل الدخول: قائمة قططي (بما فيها ما أضافني إليه المشرف مباشرة) ودعواتي المعلّقة
function startQattahListeners() {
  stopQattah();
  const u = state.user; if (!u || !state.profile) return;
  const uid = u.uid, email = lc(u.email), phone = normPhone(state.profile.phone);
  let byPhone = [], byMail = [];
  const mergeInv = () => {
    const m = new Map(); [...byPhone, ...byMail].forEach(i => m.set(i.id, i));
    QT.invites = [...m.values()].sort((a, b) => qtTs(b.createdAt) - qtTs(a.createdAt));
    QT.invites.forEach(i => { if (!QT.seen[i.id]) { QT.seen[i.id] = 1; pushLocal('دعوة لقطة جديدة', `دعاك ${i.adminName || ''} للمشاركة في «${i.qName || ''}»`, 'qinv_' + i.id); } });
    qtRepaint();
  };
  QT.unsubs.push(db.collection(QT_COL).where('memberUids', 'array-contains', uid).onSnapshot(s => {
    QT.list = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => qtTs(b.createdAt) - qtTs(a.createdAt));
    qtRepaint();
  }, e => console.warn('القطة: تعذر تحميل القائمة', e.code)));
  if (u.emailVerified) {
    if (validPhone(phone)) QT.unsubs.push(db.collection(QT_INV).where('phone', '==', phone).where('status', '==', 'pending').onSnapshot(s => {
      byPhone = s.docs.map(d => ({ id: d.id, ...d.data() })); mergeInv();
    }, e => console.warn('القطة: تعذر تحميل دعوات الجوال', e.code)));
    QT.unsubs.push(db.collection(QT_INV).where('email', '==', email).where('status', '==', 'pending').onSnapshot(s => {
      byMail = s.docs.map(d => ({ id: d.id, ...d.data() })); mergeInv();
    }, e => console.warn('القطة: تعذر تحميل دعوات البريد', e.code)));
  }
}

// فتح قطة: يستمع للوثيقة والمشاركين والمصروفات، ودعوات المعلّقة للمشرف فقط
function qtOpen(id) {
  qtLeave();
  QT.qid = id; QT.tab = 'overview'; state.view = 'qattah'; render();
  const ref = qtRef(id), uid = state.user.uid;
  const gone = () => { if (QT.qid !== id) return; qtLeave(); toast('لم تعد تملك صلاحية عرض هذه القطة', 'info'); state.view = 'home'; render(); };
  QT.dUnsubs.push(ref.onSnapshot(d => {
    if (QT.qid !== id) return;
    if (!d.exists) return gone();
    QT.q = { id: d.id, ...d.data() };
    if (qtAdminOf(QT.q) && QT.invFor !== id) {
      QT.invFor = id;
      QT.dUnsubs.push(db.collection(QT_INV).where('qid', '==', id).where('adminUid', '==', uid).where('status', '==', 'pending').onSnapshot(s => {
        if (QT.qid !== id) return;
        QT.invAdmin = s.docs.map(x => ({ id: x.id, ...x.data() })); qtRepaint();
      }, () => {}));
    }
    qtRepaint();
  }, gone));
  QT.dUnsubs.push(ref.collection('members').onSnapshot(s => {
    if (QT.qid !== id) return;
    QT.members = s.docs.map(x => ({ uid: x.id, ...x.data() })).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ar'));
    qtRepaint();
  }, () => {}));
  QT.dUnsubs.push(ref.collection('expenses').onSnapshot(s => {
    if (QT.qid !== id) return;
    QT.expenses = s.docs.map(x => ({ id: x.id, ...x.data() })).sort((a, b) => (b.date || '').localeCompare(a.date || '') || (qtTs(b.createdAt) - qtTs(a.createdAt)));
    qtRepaint();
  }, () => {}));
}

/* ---------- العرض: الرئيسية ---------- */
function qtCard(q) {
  const st = qtStatus(q), pct = qtPct(qtNum(q.collected), qtNum(q.target));
  const role = q.adminUid === state.user.uid ? ['مشرف', 'bg-indigo-100 text-indigo-700'] : q.deputyUid === state.user.uid ? ['نائب', 'bg-amber-100 text-amber-800'] : ['مشارك', 'bg-emerald-100 text-emerald-700'];
  return `<div class="jcard" data-act="qt-open" data-id="${esc(q.id)}" role="button" tabindex="0">
    <div class="flex items-center gap-3 min-w-0"><div class="jicon"><i class="fa-solid fa-hand-holding-dollar"></i></div>
      <div class="min-w-0 flex-1"><h4 class="font-black text-sm truncate">${esc(q.name)}</h4>
        <p class="text-xs text-slate-500 mt-0.5 truncate">${esc(q.reason || '')}</p>
        <div class="flex items-center gap-2 mt-1.5 flex-wrap"><div class="bar w-20"><i style="width:${pct}%"></i></div><span class="text-[11px] text-slate-500">${pct}%</span>
          <span class="bdg ${st.c}">${st.l}</span><span class="bdg ${role[1]}">${role[0]}</span></div></div></div>
    <i class="fa-solid fa-chevron-left text-slate-300"></i></div>`;
}
function qtInvitesHtml() {
  if (!QT.invites.length) return '';
  return `<div class="space-y-2"><h3 class="font-black text-sm"><i class="fa-solid fa-envelope-open-text text-amber-500"></i> دعوات قطة بانتظارك</h3>${QT.invites.map(i => `<div class="p-4 bg-amber-50 border border-amber-200 rounded-2xl flex flex-wrap justify-between items-center gap-3 text-xs">
      <div class="min-w-0"><p class="font-bold text-sm">${esc(i.qName || '')}</p><p class="text-slate-500">دعوة من ${esc(i.adminName || '')} • الهدف ${fmtNum(i.qTarget)} ريال • آخر موعد للجمع ${qtFmtDate(i.qEnd)}</p></div>
      <div class="flex gap-2"><button type="button" class="btn b-pri" data-act="qt-accept" data-id="${esc(i.id)}">قبول</button><button type="button" class="btn b-red" data-act="qt-decline" data-id="${esc(i.id)}">رفض</button></div></div>`).join('')}</div>`;
}
// يُدرج في الصفحة الرئيسية قبل قائمة الجمعيات
function qtHomeBlock() {
  const cards = QT.list.map(qtCard).join('');
  return `${qtInvitesHtml()}<div class="space-y-2.5">
    <div class="flex items-center justify-between gap-2"><h3 class="font-black text-sm"><i class="fa-solid fa-hand-holding-dollar text-amber-600"></i> القطة</h3>
      <button type="button" class="btn b-pri" data-act="qt-new"><i class="fa-solid fa-plus"></i> قطة جديدة</button></div>
    ${cards || '<div class="card p-5 text-center text-xs text-slate-500"><p>لا توجد قطة بعد. أنشئ صندوقاً مشتركاً لفعالية أو رحلة، وأضف الأفراد مباشرة أو بالدعوة.</p></div>'}</div>`;
}

/* ---------- العرض: إنشاء القطة وتعديلها ---------- */
function qtFormHtml(q, mode) {
  const v = k => esc(q && q[k] != null ? q[k] : '');
  const lbl = 'text-xs font-semibold block mb-1', today = qtDay(), minAttr = mode === 'create' ? `min="${today}"` : '';
  const dateF = (name, l, val) => `<div><label class="${lbl}">${l}</label><input name="${name}" type="date" class="inp" required ${minAttr} value="${esc(val || '')}"></div>`;
  return `<form id="${mode === 'edit' ? 'f-qat-edit' : 'f-qat-create'}" class="space-y-4">
    ${mode === 'edit' ? `<input type="hidden" name="qid" value="${esc(q.id)}">` : ''}
    <div><label class="${lbl}">اسم القطة</label><input name="qname" class="inp" required maxlength="60" value="${v('name')}" placeholder="مثال: رحلة الطائف للعائلة"></div>
    <div><label class="${lbl}">سبب القطة</label><textarea name="qreason" rows="3" class="inp" required maxlength="400" placeholder="اشرح الغرض من الجمع">${v('reason')}</textarea></div>
    <div class="grid md:grid-cols-2 gap-4">
      <div><label class="${lbl}">القيمة المطلوبة (ريال)</label><input name="qtarget" type="number" min="1" step="any" class="inp" required value="${v('target')}" oninput="qtPreview(this.form)"></div>
      <div><label class="${lbl}">عدد الأفراد المشاركين (يشمل المشرف)</label><input name="qpart" type="number" min="2" max="100" class="inp" required value="${v('participants')}" oninput="qtPreview(this.form)"></div>
    </div>
    <div class="p-3 rounded-xl bg-amber-50 border border-amber-100 text-xs flex justify-between items-center"><span>حصة كل فرد</span><b data-qt-share>${q ? fmtNum(qtShare(q)) + ' ريال' : '—'}</b></div>
    <div class="grid md:grid-cols-2 gap-4">${dateF('qcs', 'بداية الجمع', q && q.collectStart)}${dateF('qce', 'نهاية الجمع (الموعد النهائي)', q && q.collectEnd)}</div>
    <div class="grid md:grid-cols-2 gap-4">${dateF('qes', 'بداية الفعالية / الرحلة', q && q.eventStart)}${dateF('qee', 'نهاية الفعالية / الرحلة', q && q.eventEnd)}</div>
    <button class="btn b-pri w-full py-3" type="submit">${mode === 'edit' ? 'حفظ التعديلات' : 'إنشاء القطة'}</button>
  </form>`;
}
function qtCreateView() {
  return `<div class="max-w-xl mx-auto card p-8"><div class="flex justify-between items-center mb-5"><h3 class="text-xl font-bold">إنشاء جديد</h3><button data-act="go-home" class="text-slate-400" aria-label="إغلاق"><i class="fa-solid fa-xmark text-lg"></i></button></div>
    ${createTabs()}
    <div class="p-3 bg-amber-50 border border-amber-100 rounded-2xl text-xs text-amber-900 leading-relaxed mb-4">القطة صندوق مشترك لفعالية أو رحلة: تحدد الهدف والمدتين، ثم يسجّل المشرف المدفوعات ويعيّن نائباً يسجّل المصروفات معه. من تضيفه مباشرة يراها في حسابه فور دخوله.</div>
    ${qtFormHtml(null, 'create')}</div>`;
}
function qtPreview(f) {
  const el = f && f.querySelector('[data-qt-share]'); if (!el) return;
  const t = parseFloat(f.qtarget.value), p = parseInt(f.qpart.value, 10);
  el.textContent = t > 0 && p >= 2 ? fmtNum(r2(t / p)) + ' ريال' : '—';
}

/* ---------- العرض: تفاصيل القطة ---------- */
function qtSteps(q) {
  const t = qtDay(), ph = [
    { l: 'مرحلة الجمع', s: q.collectStart, e: q.collectEnd, ico: 'fa-coins', done: t > q.collectEnd, on: t >= q.collectStart && t <= q.collectEnd },
    { l: 'الفعالية / الرحلة', s: q.eventStart, e: q.eventEnd, ico: 'fa-plane-departure', done: t > q.eventEnd, on: t >= q.eventStart && t <= q.eventEnd }];
  return `<div class="grid grid-cols-2 gap-3">${ph.map(p => `<div class="card p-3 ${p.on ? 'ring-2 ring-teal-600' : ''}">
    <p class="text-[11px] font-black ${p.done ? 'text-emerald-700' : p.on ? 'text-teal-700' : 'text-slate-500'}"><i class="fa-solid ${p.done ? 'fa-circle-check' : p.ico}"></i> ${p.l}</p>
    <p class="text-[11px] text-slate-500 mt-1">من ${qtFmtDate(p.s)} إلى ${qtFmtDate(p.e)}</p></div>`).join('')}</div>`;
}
function qtView() {
  const q = QT.q;
  if (!q) return vLoading();
  const admin = qtAdminOf(q), staff = qtStaffOf(q), st = qtStatus(q);
  const coll = qtNum(q.collected), tg = qtNum(q.target), pct = qtPct(coll, tg), rem = Math.max(0, tg - coll);
  const tabs = [['overview', 'الملخص', 'fa-chart-pie'], ['members', 'المشاركون', 'fa-users'], ['expenses', 'المصروفات', 'fa-receipt']];
  const bar = `<div class="atabs">${tabs.map(([k, l, i]) => `<button type="button" class="achip ${QT.tab === k ? 'on' : ''}" data-act="qt-tab" data-v="${k}"><i class="fa-solid ${i}"></i> ${l}</button>`).join('')}</div>`;
  const body = QT.tab === 'members' ? qtMembersTab(q, admin) : QT.tab === 'expenses' ? qtExpensesTab(q, admin, staff) : qtOverviewTab(q, admin, st);
  return `<div class="space-y-4">
    <div class="flex items-center justify-between gap-2"><button type="button" class="btn b-sec" data-act="go-home"><i class="fa-solid fa-arrow-right"></i> الرئيسية</button>
      ${admin ? `<div class="flex gap-2"><button type="button" class="btn b-sec" data-act="qt-edit" aria-label="تعديل القطة"><i class="fa-solid fa-pen"></i></button><button type="button" class="btn b-red" data-act="qt-del" aria-label="حذف القطة"><i class="fa-solid fa-trash-can"></i></button></div>` : ''}</div>
    <section class="hero">
      <div class="flex justify-between items-start gap-3"><div class="min-w-0"><p class="text-[11px] opacity-80 font-bold">القطة</p><h2 class="text-lg font-black leading-snug">${esc(q.name)}</h2>${q.reason ? `<p class="text-xs opacity-80 mt-1 leading-relaxed">${esc(q.reason)}</p>` : ''}</div>
        <span class="bdg ${st.c} flex-none"><i class="fa-solid ${st.i}"></i> ${st.l}</span></div>
      <div class="mt-4"><p class="text-[11px] opacity-80">المبلغ المحصّل</p><p class="text-3xl font-black">${fmtNum(coll)} <span class="text-sm font-bold opacity-80">ريال</span></p>
        <div class="hbar mt-2" style="background:rgba(255,255,255,.22)"><i style="width:${pct}%"></i></div>
        <p class="text-[11px] opacity-90 mt-1">${pct}% من ${fmtNum(tg)} ريال${rem ? ' • متبقٍ ' + fmtNum(rem) : ' • اكتمل الهدف'}</p></div>
    </section>
    ${qtSteps(q)}${bar}${body}
  </div>`;
}
function qtOverviewTab(q, admin, st) {
  const coll = qtNum(q.collected), tg = qtNum(q.target), share = qtShare(q);
  const paidN = QT.members.filter(m => share > 0 && qtNum(m.paid) >= share).length;
  const left = Math.max(0, qtDaysBetween(qtDay(), q.collectEnd));
  const tile = (l, v, c) => `<div class="card p-4"><p class="text-[11px] text-slate-500 font-bold">${l}</p><p class="text-lg font-black mt-1 ${c}">${v}</p></div>`;
  return `<div class="grid grid-cols-2 gap-3">${tile('المحصّل', fmtNum(coll) + ' ريال', 'text-emerald-700')}${tile('المتبقي للهدف', fmtNum(Math.max(0, tg - coll)) + ' ريال', 'text-amber-700')}${tile('حصة الفرد', fmtNum(share) + ' ريال', 'text-slate-800')}${tile('المسددون', `${paidN} من ${q.participants}`, 'text-slate-800')}</div>
    <div class="card p-5 space-y-3"><h4 class="font-black text-sm"><i class="fa-solid fa-lightbulb text-amber-500"></i> الحالة الآن</h4>
      <p class="text-xs text-slate-600 leading-relaxed">${qtAdvice(q, st)}</p>
      <div class="text-xs text-slate-500 space-y-1.5"><p><i class="fa-solid fa-user-tie w-4"></i> المشرف: ${esc(q.adminName || '—')}</p>
        <p><i class="fa-solid fa-user-shield w-4"></i> النائب: ${q.deputyUid ? esc(q.deputyName || '—') : 'لم يُعيّن بعد'}</p>
        ${st.k === 'collecting' ? `<p><i class="fa-regular fa-calendar w-4"></i> ينتهي الجمع بعد ${left} يوم (${qtFmtDate(q.collectEnd)})</p>` : `<p><i class="fa-regular fa-calendar w-4"></i> الفعالية: ${qtFmtDate(q.eventStart)} حتى ${qtFmtDate(q.eventEnd)}</p>`}
      </div></div>`;
}
function qtMembersTab(q, admin) {
  const share = qtShare(q), me = state.user.uid;
  const rows = QT.members.map(m => {
    const paid = qtNum(m.paid), full = share > 0 && paid >= share, part = paid > 0 && !full;
    const role = m.uid === q.adminUid ? ['مشرف', 'bg-indigo-100 text-indigo-700'] : m.uid === q.deputyUid ? ['نائب', 'bg-amber-100 text-amber-800'] : ['مشارك', 'bg-slate-100 text-slate-600'];
    const pay = full ? ['مسدد', 'bg-emerald-100 text-emerald-700'] : part ? ['جزئي', 'bg-sky-100 text-sky-700'] : ['بانتظار السداد', 'bg-rose-50 text-rose-600'];
    const tick = admin
      ? `<button type="button" data-act="qt-paid" data-uid="${esc(m.uid)}" aria-label="تغيير حالة السداد" class="w-8 h-8 rounded-lg border-2 flex-none flex items-center justify-center ${full ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-slate-300 bg-white'}">${full ? '<i class="fa-solid fa-check text-xs"></i>' : ''}</button>`
      : `<span class="w-8 h-8 rounded-lg flex-none flex items-center justify-center ${full ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'}"><i class="fa-solid ${full ? 'fa-check' : 'fa-minus'} text-xs"></i></span>`;
    const tools = admin ? `${!full && m.phone && m.uid !== me ? `<a href="${waLink(m.phone, qtRemindText(q, m, share - paid))}" target="_blank" rel="noopener" class="btn b-sec" aria-label="تذكير عبر واتساب"><i class="fa-brands fa-whatsapp text-emerald-600"></i></a>` : ''}
      <button type="button" data-act="qt-pay" data-uid="${esc(m.uid)}" class="btn b-sec" aria-label="تسجيل مبلغ"><i class="fa-solid fa-pen"></i></button>
      ${m.uid !== q.adminUid ? `<button type="button" data-act="qt-rm" data-uid="${esc(m.uid)}" class="btn b-red" aria-label="إزالة المشارك"><i class="fa-solid fa-user-minus"></i></button>` : ''}` : '';
    return `<div class="p-3 bg-white border border-slate-100 rounded-xl flex items-center gap-3 flex-wrap">${tick}
      <div class="min-w-0 flex-1"><div class="flex items-center gap-1.5 flex-wrap"><b class="text-sm">${esc(m.name || '—')}</b><span class="bdg ${role[1]}">${role[0]}</span>${m.uid === me ? '<span class="bdg bg-emerald-50 text-emerald-700">أنت</span>' : ''}</div>
        <p class="text-[11px] text-slate-500 mt-0.5"><span dir="ltr">${esc(m.phone || '')}</span> • مدفوع ${fmtNum(paid)} من ${fmtNum(share)} ريال</p></div>
      <div class="flex items-center gap-1.5 flex-wrap"><span class="bdg ${pay[1]}">${pay[0]}</span>${tools}</div></div>`;
  }).join('');
  const head = `<div class="card p-4 flex items-center justify-between gap-2 text-xs"><span class="font-black">${QT.members.length} من ${q.participants} مشاركاً</span><span class="text-slate-500">${admin ? 'اضغط المربع لتسجيل السداد الكامل' : 'عرض فقط'}</span></div>`;
  return `<div class="space-y-3">${head}${admin ? qtAdminPanels(q) : ''}<div class="space-y-2">${rows || '<p class="text-center text-xs text-slate-400 py-6">لا يوجد مشاركون بعد</p>'}</div></div>`;
}
function qtAdminPanels(q) {
  const free = Math.max(0, qtNum(q.participants) - (q.memberUids || []).length - QT.invAdmin.length);
  const opts = QT.members.filter(m => m.uid !== q.adminUid).map(m => `<option value="${esc(m.uid)}" ${m.uid === q.deputyUid ? 'selected' : ''}>${esc(m.name || '—')}</option>`).join('');
  const inv = QT.invAdmin.map(i => `<div class="p-3 bg-sky-50 border border-sky-100 rounded-xl flex flex-wrap items-center justify-between gap-2 text-xs">
      <div class="min-w-0"><b>${esc(i.invitedName || '—')}</b> <span dir="ltr" class="text-slate-500">${esc(i.phone || i.email || '')}</span><p class="text-[10px] text-sky-700 mt-0.5">بانتظار القبول</p></div>
      <div class="flex gap-1.5"><button type="button" class="btn b-sec" data-act="qt-inv-share" data-id="${esc(i.id)}" aria-label="مشاركة الدعوة"><i class="fa-solid fa-share-nodes"></i></button>
      <button type="button" class="btn b-red" data-act="qt-inv-cancel" data-id="${esc(i.id)}" aria-label="إلغاء الدعوة"><i class="fa-solid fa-xmark"></i></button></div></div>`).join('');
  return `<form id="f-qt-add" class="card p-4 space-y-3">
      <div class="flex items-center justify-between gap-2"><h4 class="font-black text-sm"><i class="fa-solid fa-user-plus text-teal-700"></i> إضافة مشارك</h4><span class="text-[11px] text-slate-500">متبقٍ ${free} مكان</span></div>
      <div class="grid md:grid-cols-2 gap-3"><input name="mname" class="inp" required maxlength="40" placeholder="الاسم"><input name="mcontact" class="inp" required dir="ltr" placeholder="05xxxxxxxx أو البريد"></div>
      <p class="text-[11px] text-slate-500 leading-relaxed">إن كان الجوال مسجلاً في التطبيق يُضاف مباشرة، ويظهر له هذا التعاون عند دخوله. وإن لم يكن مسجلاً أو كان بريداً، تُرسل له دعوة يقبلها من حسابه.</p>
      <button class="btn b-pri w-full" type="submit">إضافة</button></form>
    <form id="f-qt-deputy" class="card p-4 flex flex-wrap items-end gap-3"><div class="flex-1 min-w-[10rem]"><label class="text-xs font-semibold block mb-1">النائب (يسجّل المصروفات مع المشرف)</label>
      <select name="duid" class="inp"><option value="">بدون نائب</option>${opts}</select></div><button class="btn b-pri" type="submit">حفظ النائب</button></form>
    ${inv ? `<div class="space-y-2"><h4 class="font-black text-xs text-slate-600">دعوات بانتظار القبول</h4>${inv}</div>` : ''}`;
}
function qtExpensesTab(q, admin, staff) {
  const coll = qtNum(q.collected), tg = qtNum(q.target);
  if (!qtUnlocked(q)) return `<div class="card p-6 text-center space-y-3"><div class="mx-auto w-14 h-14 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center text-xl"><i class="fa-solid fa-lock"></i></div>
    <h4 class="font-black">المصروفات مقفلة</h4><p class="text-xs text-slate-500 leading-relaxed">تُفتح تلقائياً عند اكتمال المبلغ المستهدف (${fmtNum(tg)} ريال)، وباقي ${fmtNum(Math.max(0, tg - coll))} ريال.</p>
    ${admin ? '<button type="button" class="btn b-sec" data-act="qt-unlock"><i class="fa-solid fa-lock-open"></i> فتح المصروفات مبكراً</button>' : ''}</div>`;
  const spent = r2(QT.expenses.reduce((t, e) => t + qtNum(e.amount), 0)), left = r2(coll - spent), spentPct = qtPct(spent, coll);
  const sum = (l, v, c) => `<div class="card p-3 text-center"><p class="text-[10px] text-slate-500 font-bold">${l}</p><p class="font-black text-sm mt-1 ${c}">${fmtNum(v)}</p></div>`;
  const form = staff ? `<form id="f-qt-exp" class="card p-4 space-y-3"><h4 class="font-black text-sm"><i class="fa-solid fa-receipt text-teal-700"></i> تسجيل مصروف</h4>
      <div class="grid md:grid-cols-3 gap-3"><input name="ename" class="inp" required maxlength="80" placeholder="البند: فندق، وقود، ضيافة"><input name="eamount" type="number" min="0.01" step="any" class="inp" required placeholder="المبلغ (ريال)"><input name="edate" type="date" class="inp" required value="${qtDay()}"></div>
      <button class="btn b-pri w-full" type="submit">إضافة المصروف</button></form>` : '';
  const rows = QT.expenses.map(e => `<div class="p-3 bg-white border border-slate-100 rounded-xl flex items-center justify-between gap-2 text-xs">
      <div class="min-w-0"><p class="font-bold text-sm truncate">${esc(e.name)}</p><p class="text-[10px] text-slate-400">${qtFmtDate(e.date)} • ${esc(e.byName || '—')}</p></div>
      <div class="flex items-center gap-2 flex-none"><b class="text-sm">${fmtNum(e.amount)} ريال</b>${staff ? `<button type="button" data-act="qt-exp-del" data-id="${esc(e.id)}" class="text-rose-500 px-2" aria-label="حذف المصروف"><i class="fa-solid fa-trash-can"></i></button>` : ''}</div></div>`).join('');
  return `<div class="space-y-3">
    <div class="grid grid-cols-3 gap-2">${sum('المحصّل', coll, 'text-emerald-700')}${sum('المصروف', spent, 'text-rose-600')}${sum('المتبقي', left, left < 0 ? 'text-rose-600' : 'text-slate-800')}</div>
    <div class="card p-4"><div class="flex justify-between text-[11px] text-slate-500 mb-1.5"><span>نسبة الصرف من المحصّل</span><b>${spentPct}%</b></div>
      <div class="hbar"><i style="width:${spentPct}%;${spent > coll ? 'background:var(--loss)' : ''}"></i></div>
      ${spent > coll ? `<p class="text-[11px] text-rose-600 mt-2">المصروف تجاوز المحصّل بمقدار ${fmtNum(spent - coll)} ريال.</p>` : ''}</div>
    ${form}
    <div class="space-y-2">${rows || '<p class="text-center text-xs text-slate-400 py-6">لا توجد مصروفات مسجّلة بعد</p>'}</div></div>`;
}

/* ---------- الإنشاء والتعديل ---------- */
function qtReadForm(f, isNew) {
  const v = {
    name: f.qname.value.trim(), reason: f.qreason.value.trim(), target: parseFloat(f.qtarget.value),
    participants: parseInt(f.qpart.value, 10), collectStart: f.qcs.value, collectEnd: f.qce.value, eventStart: f.qes.value, eventEnd: f.qee.value
  };
  const today = qtDay();
  if (!v.name || !v.reason) { toast('أكمل الحقول المطلوبة', 'error'); return null; }
  if (!(v.target >= 1)) { toast('حدد القيمة المطلوبة بشكل صحيح', 'error'); return null; }
  if (!(v.participants >= 2 && v.participants <= 100)) { toast('عدد المشاركين بين 2 و 100', 'error'); return null; }
  if (![v.collectStart, v.collectEnd, v.eventStart, v.eventEnd].every(qtDateOk)) { toast('تحقق من التواريخ', 'error'); return null; }
  if (v.collectEnd < v.collectStart) { toast('نهاية الجمع يجب ألا تسبق بدايته', 'error'); return null; }
  if (v.eventStart < v.collectStart) { toast('بداية الفعالية يجب ألا تسبق بداية الجمع', 'error'); return null; }
  if (v.eventEnd < v.eventStart) { toast('نهاية الفعالية يجب ألا تسبق بدايتها', 'error'); return null; }
  if (isNew && (v.collectEnd < today || v.eventEnd < today)) { toast('التواريخ يجب ألا تكون في الماضي', 'error'); return null; }
  return v;
}
function qtCreate(f) { needVerified(() => qtCreateCore(f)); }
async function qtCreateCore(f) {
  const v = qtReadForm(f, true); if (!v) return;
  const uid = state.user.uid, p = state.profile || {}, ref = db.collection(QT_COL).doc(), b = db.batch();
  b.set(ref, { ...v, adminUid: uid, adminName: dispName(p), deputyUid: '', deputyName: '', memberUids: [uid], collected: 0, expOpen: false, createdAt: FV.serverTimestamp() });
  b.set(ref.collection('members').doc(uid), qtMemberDoc(uid, dispName(p), p.phone, true));
  try { await b.commit(); toast('تم إنشاء القطة'); qtOpen(ref.id); }
  catch (e) { toast('تعذر الإنشاء: ' + e.message, 'error'); }
}
function qtOpenEdit() { const q = QT.q; if (!q || !qtAdminOf(q)) return; showModal('تعديل القطة', qtFormHtml(q, 'edit')); }
async function qtEditSubmit(f) {
  const q = QT.q; if (!q || !qtAdminOf(q) || f.qid.value !== q.id) return;
  const v = qtReadForm(f, false); if (!v) return;
  if (QT.members.length > v.participants) return toast('عدد المشاركين أقل من الأعضاء الحاليين', 'error');
  try { await qtRef(q.id).update(v); closeModal(); toast('حُفظت التعديلات'); }
  catch (e) { toast('تعذر الحفظ: ' + e.message, 'error'); }
}
async function qtDelete() {
  const q = QT.q; if (!q || !qtAdminOf(q)) return;
  if (!confirm(`حذف القطة «${q.name}» نهائياً مع مشاركيها ومصروفاتها؟`)) return;
  try {
    const me = state.user.uid, base = qtRef(q.id), refs = [];
    const [m, e, iv] = await Promise.all([
      base.collection('members').get(), base.collection('expenses').get(),
      db.collection(QT_INV).where('qid', '==', q.id).where('adminUid', '==', me).get()]);
    m.docs.forEach(d => refs.push(d.ref)); e.docs.forEach(d => refs.push(d.ref)); iv.docs.forEach(d => refs.push(d.ref));
    refs.push(base); // الوثيقة الرئيسية آخراً، لأن قواعد الحذف للعناصر الفرعية تقرأها
    for (let i = 0; i < refs.length; i += 400) { const b = db.batch(); refs.slice(i, i + 400).forEach(r => b.delete(r)); await b.commit(); }
    qtLeave(); state.view = 'home'; render(); toast('حُذفت القطة', 'info');
  } catch (err) { toast('تعذر الحذف: ' + err.message, 'error'); }
}

/* ---------- الدعوات والمشاركون ---------- */
async function qtAddMember(f) {
  const q = QT.q; if (!q || !qtAdminOf(q)) return;
  const name = f.mname.value.trim(), c = f.mcontact.value.trim(), isMail = c.includes('@');
  const phone = isMail ? '' : normPhone(c), email = isMail ? lc(c) : '';
  if (name.length < 2) return toast('اكتب اسم المشارك', 'error');
  if (isMail ? !validEmail(email) : !validPhone(phone)) return toast('أدخل جوالاً سعودياً (05xxxxxxxx) أو بريداً صحيحاً', 'error');
  if ((q.memberUids || []).length + QT.invAdmin.length >= qtNum(q.participants)) return toast('اكتمل عدد المشاركين', 'error');

  // جوال مسجّل في التطبيق: إضافة مباشرة بلا دعوة
  if (!isMail) {
    const ps = await db.collection('phones').doc(phone).get().catch(() => null);
    const uid = ps && ps.exists ? ps.data().uid : '';
    if (uid) {
      if ((q.memberUids || []).includes(uid)) return toast('هذا المشارك موجود بالفعل', 'error');
      const ref = qtRef(q.id), b = db.batch();
      b.update(ref, { memberUids: FV.arrayUnion(uid) });
      b.set(ref.collection('members').doc(uid), qtMemberDoc(uid, name, phone, true));
      try { await b.commit(); f.reset(); toast(`أُضيف ${name} مباشرة، وسيرى القطة في حسابه عند دخوله`); }
      catch (e) { toast('تعذرت الإضافة: ' + e.message, 'error'); }
      return;
    }
  }

  // غير مسجّل أو بريد: دعوة معلّقة
  const iid = q.id + (isMail ? '__' + email : '__p' + phone), iref = db.collection(QT_INV).doc(iid);
  const ex = await iref.get().catch(() => null);
  if (ex && ex.exists && ex.data().status === 'pending') return toast('أُرسلت دعوة لهذا الشخص سابقاً', 'error');
  const inv = { qid: q.id, qName: q.name, qTarget: qtNum(q.target), qEnd: q.collectEnd, adminUid: q.adminUid, adminName: q.adminName || '', invitedName: name, phone, email, invitedBy: state.user.uid, status: 'pending', createdAt: FV.serverTimestamp() };
  try { await iref.set(inv); f.reset(); qtShowInvite({ ...inv, id: iid }); }
  catch (e) { toast('تعذر إرسال الدعوة: ' + e.message, 'error'); }
}
function qtShowInvite(i) {
  if (!i) return;
  const q = QT.q, share = q ? qtShare(q) : 0, target = q ? q.target : 0;
  QT.shareText = qtInviteText({ name: i.invitedName, admin: i.adminName, qName: i.qName, target, share });
  const wa = i.phone ? `<a href="${waLink(i.phone, QT.shareText)}" target="_blank" rel="noopener" class="btn b-pri w-full"><i class="fa-brands fa-whatsapp"></i> إرسال عبر واتساب</a>` : '';
  showModal('دعوة إلى القطة', `<div class="space-y-3"><p class="text-xs text-slate-500">${i.phone ? 'تُرسل الدعوة إلى الجوال' : 'تظهر الدعوة له عند تسجيل الدخول بهذا البريد'}: <b dir="ltr">${esc(i.phone || i.email)}</b></p>
    <pre class="whitespace-pre-wrap text-xs bg-slate-50 border border-slate-100 rounded-xl p-3 leading-relaxed">${esc(QT.shareText)}</pre>
    ${wa}<button type="button" class="btn b-sec w-full" data-act="qt-copy"><i class="fa-regular fa-copy"></i> نسخ نص الدعوة</button></div>`);
}
async function qtAccept(iid) {
  const i = QT.invites.find(x => x.id === iid); if (!i) return;
  const uid = state.user.uid, p = state.profile || {}, ref = qtRef(i.qid), b = db.batch();
  b.update(ref, { memberUids: FV.arrayUnion(uid) });
  b.set(ref.collection('members').doc(uid), qtMemberDoc(uid, dispName(p), p.phone, false));
  b.update(db.collection(QT_INV).doc(iid), { status: 'accepted' });
  try { await b.commit(); toast('تم قبول الدعوة'); qtOpen(i.qid); }
  catch (e) { toast('تعذر القبول: ' + e.message, 'error'); }
}
async function qtDecline(iid) {
  try { await db.collection(QT_INV).doc(iid).update({ status: 'declined' }); toast('تم رفض الدعوة', 'info'); }
  catch (e) { toast('تعذر الرفض: ' + e.message, 'error'); }
}
async function qtCancelInvite(iid) {
  try { await db.collection(QT_INV).doc(iid).delete(); toast('أُلغيت الدعوة', 'info'); }
  catch (e) { toast('تعذر الإلغاء: ' + e.message, 'error'); }
}
async function qtRemove(uid) {
  const q = QT.q, m = QT.members.find(x => x.uid === uid);
  if (!q || !m || !qtAdminOf(q) || uid === q.adminUid) return;
  const paid = qtNum(m.paid);
  if (!confirm(`إزالة ${m.name || 'المشارك'} من القطة؟` + (paid > 0 ? `\nسيُخصم ما سدده (${fmtNum(paid)} ريال) من المحصّل.` : ''))) return;
  const ref = qtRef(q.id), b = db.batch(), upd = { memberUids: FV.arrayRemove(uid) };
  if (q.deputyUid === uid) { upd.deputyUid = ''; upd.deputyName = ''; }
  if (paid) upd.collected = FV.increment(-paid);
  b.update(ref, upd); b.delete(ref.collection('members').doc(uid));
  try { await b.commit(); toast('أُزيل المشارك', 'info'); }
  catch (e) { toast('تعذرت الإزالة: ' + e.message, 'error'); }
}
async function qtSetDeputy(f) {
  const q = QT.q; if (!q || !qtAdminOf(q)) return;
  const uid = f.duid.value, m = QT.members.find(x => x.uid === uid);
  if (uid && (!m || uid === q.adminUid)) return toast('اختر نائباً من المشاركين', 'error');
  try { await qtRef(q.id).update({ deputyUid: uid, deputyName: m ? (m.name || '') : '' }); toast(uid ? 'عُيّن النائب' : 'أُلغي تعيين النائب', 'info'); }
  catch (e) { toast('تعذر الحفظ: ' + e.message, 'error'); }
}

/* ---------- السداد ---------- */
async function qtSetPaid(uid, val) {
  const q = QT.q, m = QT.members.find(x => x.uid === uid); if (!q || !m || !qtAdminOf(q)) return;
  const delta = r2(val - qtNum(m.paid)), ref = qtRef(q.id), b = db.batch();
  b.update(ref.collection('members').doc(uid), { paid: val });
  if (delta) b.update(ref, { collected: FV.increment(delta) });
  try { await b.commit(); }
  catch (e) { toast('تعذر حفظ السداد: ' + e.message, 'error'); }
}
function qtTogglePaid(uid) {
  const q = QT.q, m = QT.members.find(x => x.uid === uid); if (!q || !m) return;
  const share = qtShare(q), full = share > 0 && qtNum(m.paid) >= share;
  qtSetPaid(uid, full ? 0 : share);
}
function qtOpenPay(uid) {
  const q = QT.q, m = QT.members.find(x => x.uid === uid); if (!q || !m || !qtAdminOf(q)) return;
  showModal('تسجيل مبلغ: ' + esc(m.name || ''), `<form id="f-qt-pay" class="space-y-3"><input type="hidden" name="puid" value="${esc(uid)}">
    <p class="text-xs text-slate-500">حصة الفرد ${fmtNum(qtShare(q))} ريال. أدخل إجمالي ما سدّده حتى الآن.</p>
    <input name="pamount" type="number" min="0" step="any" class="inp" required value="${qtNum(m.paid)}">
    <button class="btn b-pri w-full py-3" type="submit">حفظ</button></form>`);
}
async function qtSavePay(f) {
  const amt = parseFloat(f.pamount.value);
  if (!(amt >= 0)) return toast('المبلغ غير صحيح', 'error');
  await qtSetPaid(f.puid.value, r2(amt));
  closeModal();
}
async function qtToggleUnlock() {
  const q = QT.q; if (!q || !qtAdminOf(q)) return;
  try { await qtRef(q.id).update({ expOpen: !q.expOpen }); toast(q.expOpen ? 'أُقفلت المصروفات' : 'فُتحت المصروفات', 'info'); }
  catch (e) { toast('تعذر التحديث: ' + e.message, 'error'); }
}

/* ---------- المصروفات ---------- */
async function qtAddExpense(f) {
  const q = QT.q; if (!q || !qtStaffOf(q)) return toast('المصروفات للمشرف ونائبه فقط', 'error');
  const name = f.ename.value.trim(), amount = r2(parseFloat(f.eamount.value)), date = f.edate.value;
  if (!name) return toast('اكتب بند المصروف', 'error');
  if (!(amount > 0)) return toast('المبلغ غير صحيح', 'error');
  if (!qtDateOk(date)) return toast('حدد التاريخ', 'error');
  try {
    await qtRef(q.id).collection('expenses').add({ name, amount, date, uid: state.user.uid, byName: dispName(state.profile), createdAt: FV.serverTimestamp() });
    f.reset(); f.edate.value = qtDay(); toast('أُضيف المصروف');
  } catch (e) { toast('تعذر الحفظ: ' + e.message, 'error'); }
}
async function qtDelExp(id) {
  const q = QT.q; if (!q || !qtStaffOf(q)) return;
  if (!confirm('حذف هذا المصروف؟')) return;
  try { await qtRef(q.id).collection('expenses').doc(id).delete(); toast('حُذف المصروف', 'info'); }
  catch (e) { toast('تعذر الحذف: ' + e.message, 'error'); }
}

/* ---------- ربط الأحداث بالتطبيق الرئيسي ---------- */
const QT_ACTIONS = {
  'qt-new': () => { qtLeave(); state.createType = 'qattah'; state.view = 'create'; render(); },
  'qt-open': el => qtOpen(el.dataset.id),
  'qt-tab': el => { QT.tab = el.dataset.v; render(); window.scrollTo({ top: 0 }); },
  'qt-accept': el => qtAccept(el.dataset.id),
  'qt-decline': el => qtDecline(el.dataset.id),
  'qt-paid': el => qtTogglePaid(el.dataset.uid),
  'qt-pay': el => qtOpenPay(el.dataset.uid),
  'qt-rm': el => qtRemove(el.dataset.uid),
  'qt-edit': () => qtOpenEdit(),
  'qt-del': () => qtDelete(),
  'qt-unlock': () => qtToggleUnlock(),
  'qt-exp-del': el => qtDelExp(el.dataset.id),
  'qt-inv-share': el => qtShowInvite(QT.invAdmin.find(x => x.id === el.dataset.id)),
  'qt-inv-cancel': el => qtCancelInvite(el.dataset.id),
  'qt-copy': () => copyText(QT.shareText || '', 'تم نسخ نص الدعوة')
};
const QT_FORMS = {
  'f-qat-create': qtCreate,
  'f-qat-edit': qtEditSubmit,
  'f-qt-add': qtAddMember,
  'f-qt-pay': qtSavePay,
  'f-qt-exp': qtAddExpense,
  'f-qt-deputy': qtSetDeputy
};
