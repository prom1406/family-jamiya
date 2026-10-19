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

const QT = { list: [], invites: [], q: null, qid: null, members: [], expenses: [], invAdmin: [], invFor: null, subFor: null, claims: [], reqs: [], spent: {}, expUnsubs: {}, tab: 'overview', unsubs: [], dUnsubs: [], seen: {}, pend: false, shareText: '' };
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
const qtStaffUids = q => [q.adminUid, q.deputyUid].filter(Boolean);
const qtJid = id => 'qt:' + id;
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
  QT.q = null; QT.qid = null; QT.members = []; QT.expenses = []; QT.invAdmin = [];
  QT.invFor = null; QT.subFor = null; QT.claims = []; QT.reqs = [];
}

function stopQattah() {
  QT.unsubs.forEach(u => u()); QT.unsubs = [];
  Object.values(QT.expUnsubs).forEach(u => u()); QT.expUnsubs = {}; QT.spent = {};
  qtLeave(); QT.list = []; QT.invites = []; QT.seen = {};
}

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
    qtSyncCard();
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
  const byDate = (a, b) => qtTs(b.createdAt) - qtTs(a.createdAt);
  QT.dUnsubs.push(ref.onSnapshot(d => {
    if (QT.qid !== id) return;
    if (!d.exists) return gone();
    QT.q = { id: d.id, ...d.data() };
    const isA = qtAdminOf(QT.q);
    if (isA && QT.invFor !== id) {
      QT.invFor = id;
      QT.dUnsubs.push(db.collection(QT_INV).where('qid', '==', id).where('adminUid', '==', uid).where('status', '==', 'pending').onSnapshot(s => {
        if (QT.qid !== id) return;
        QT.invAdmin = s.docs.map(x => ({ id: x.id, ...x.data() })); qtRepaint();
      }, () => {}));
    }
    if (QT.subFor !== id) {
      QT.subFor = id;
      const cq = isA ? ref.collection('claims') : ref.collection('claims').where('uid', '==', uid);
      const rq = isA ? ref.collection('expReqs') : ref.collection('expReqs').where('uid', '==', uid);
      QT.dUnsubs.push(cq.onSnapshot(s => { if (QT.qid !== id) return; QT.claims = s.docs.map(x => ({ id: x.id, ...x.data() })).sort(byDate); qtRepaint(); }, () => {}));
      QT.dUnsubs.push(rq.onSnapshot(s => { if (QT.qid !== id) return; QT.reqs = s.docs.map(x => ({ id: x.id, ...x.data() })).sort(byDate); qtRepaint(); }, () => {}));
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

/* ---------- بيانات بطاقة القطة: المصاريف وحساب المشرف ---------- */
// حساب المشرف يُنسخ من ملفه الشخصي إلى وثيقة القطة حتى يراه الأعضاء
const qtAcctOf = p => ({ adminBank: (p && p.bank) || '', adminIban: (p && p.iban) || '', adminPhone: (p && p.phone) || '' });

function qtSyncCard() {
  const p = state.profile || {}, want = qtAcctOf(p);
  QT.list.filter(x => x.adminUid === state.user.uid && (
      (x.adminBank || '') !== want.adminBank || (x.adminIban || '') !== want.adminIban || (x.adminPhone || '') !== want.adminPhone))
    .forEach(x => qtRef(x.id).update(want).catch(() => {}));
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
  return `<div class="space-y-2.5"><div class="sw-sec"><h3>القطة</h3>
      <button type="button" class="sw-add" data-act="qt-new"><i class="fa-solid fa-plus"></i> قطة جديدة</button></div>
    ${cards || '<div class="card p-6 text-center text-xs text-slate-500">لا توجد قطة بعد. أنشئ صندوقاً مشتركاً لفعالية أو رحلة.</div>'}</div>`;
}
// حقول النموذج فقط (mode: create | edit | wizard). في المعالج تُحسب الحصة في «الملخص الفوري» فلا حاجة لبطاقة الحصة ولا لمعالجات oninput
function qtFieldsHtml(q, mode) {
  const v = k => esc(q && q[k] != null ? q[k] : '');
  const lbl = 'text-xs font-semibold block mb-1', today = qtDay(), minAttr = mode === 'edit' ? '' : `min="${today}"`, wiz = mode === 'wizard';
  const dateF = (name, l, val) => `<div><label class="${lbl}">${l}</label><input name="${name}" type="date" class="inp" required ${minAttr} value="${esc(val || '')}"></div>`;
  const live = wiz ? '' : ' oninput="qtPreview(this.form)"';
  return `${mode === 'edit' ? `<input type="hidden" name="qid" value="${esc(q.id)}">` : ''}
    <div><label class="${lbl}">اسم القطة</label><input name="qname" class="inp" required maxlength="60" value="${v('name')}" placeholder="مثال: رحلة الطائف للعائلة"></div>
    <div><label class="${lbl}">سبب القطة</label><textarea name="qreason" rows="3" class="inp" required maxlength="400" placeholder="اشرح الغرض من الجمع">${v('reason')}</textarea></div>
    <div class="grid md:grid-cols-2 gap-4">
      <div><label class="${lbl}">القيمة المطلوبة (ريال)</label><input name="qtarget" type="number" min="1" step="any" class="inp" required value="${v('target')}"${live}></div>
      <div><label class="${lbl}">عدد الأفراد المشاركين (يشمل المشرف)</label><input name="qpart" type="number" min="2" max="100" class="inp" required value="${v('participants')}"${live}></div>
    </div>
    ${wiz ? '' : `<div class="p-3 rounded-xl bg-amber-50 border border-amber-100 text-xs flex justify-between items-center"><span>حصة كل فرد</span><b data-qt-share>${q ? fmtNum(qtShare(q)) + ' ريال' : '—'}</b></div>`}
    <div class="grid md:grid-cols-2 gap-4">${dateF('qcs', 'بداية الجمع', q && q.collectStart)}${dateF('qce', 'نهاية الجمع (الموعد النهائي)', q && q.collectEnd)}</div>
    <div class="grid md:grid-cols-2 gap-4">${dateF('qes', 'بداية الفعالية / الرحلة', q && q.eventStart)}${dateF('qee', 'نهاية الفعالية / الرحلة', q && q.eventEnd)}</div>`;
}
function qtFormHtml(q, mode) {
  return `<form id="${mode === 'edit' ? 'f-qat-edit' : 'f-qat-create'}" class="space-y-4">${qtFieldsHtml(q, mode)}
    <button class="btn b-pri w-full py-3" type="submit">${mode === 'edit' ? 'حفظ التعديلات' : 'إنشاء القطة'}</button>
  </form>`;
}
function qtPreview(f) {
  const el = f && f.querySelector('[data-qt-share]'); if (!el) return;
  const t = parseFloat(f.qtarget.value), p = parseInt(f.qpart.value, 10);
  el.textContent = t > 0 && p >= 2 ? fmtNum(r2(t / p)) + ' ريال' : '—';
}

/* ---------- العرض: تفاصيل القطة (بنفس تخطيط الجمعية والتعاون العائلي) ---------- */
const qtBox = (ttl, body) => `<div class="card p-5 space-y-3">${ttl ? `<h4 class="font-black text-sm">${ttl}</h4>` : ''}${body}</div>`;
const qtTile = (t, v) => `<div class="p-2.5 bg-slate-50 rounded-xl"><p class="text-[10px] text-slate-500">${t}</p><b class="text-xs">${v}</b></div>`;
const qtEmpty = t => `<p class="text-xs text-slate-400 text-center py-3">${t}</p>`;

function qtView() {
  const q = QT.q;
  if (!q) return vLoading();
  const admin = qtAdminOf(q), staff = qtStaffOf(q), st = qtStatus(q);
  const coll = qtNum(q.collected), tg = qtNum(q.target), pct = qtPct(coll, tg), share = qtShare(q);
  const mine = QT.members.find(m => m.uid === state.user.uid), myDue = mine ? qtDue(q, mine) : 0;
  const memberBtns = !admin && mine ? `<div class="grid grid-cols-2 gap-2">
      <button type="button" class="btn b-white" data-act="qt-claim-modal"><i class="fa-solid fa-circle-check"></i> تأكيد السداد</button>
      <button type="button" class="btn bg-white/20 text-white" data-act="qt-req-modal"><i class="fa-solid fa-receipt"></i> طلب إضافة مصروف</button></div>` : '';

  const hero = `<div class="rounded-3xl p-5 text-white shadow-lg space-y-4" style="background:linear-gradient(135deg,#0f4c3a,#1e5a46 55%,#0fb16b)">
    <div class="flex justify-between items-start gap-3"><div class="min-w-0"><p class="text-[11px] text-emerald-100 font-bold">القطة</p>
      <h3 class="text-xl font-black leading-snug">${esc(q.name)}</h3>${q.reason ? `<p class="text-xs text-emerald-50/90 mt-1 leading-relaxed">${esc(q.reason)}</p>` : ''}</div>
      <span class="flex-none px-2.5 py-1 rounded-full text-[10px] font-black bg-white/25"><i class="fa-solid ${st.i}"></i> ${st.l}</span></div>
    <div><div class="flex justify-between text-[11px] text-emerald-100 mb-1"><span>المحصّل ${fmtNum(coll)} ريال</span><span>من ${fmtNum(tg)} • ${pct}%</span></div>
      <div class="h-2.5 rounded-full bg-white/25 overflow-hidden"><div class="h-full rounded-full bg-white" style="width:${pct}%"></div></div></div>
    <div class="grid grid-cols-2 gap-2 text-center"><div class="rounded-2xl bg-white/15 py-2"><span class="text-[10px] text-emerald-100 block">آخر موعد للجمع</span><b class="text-xs block">${qtFmtDate(q.collectEnd)}</b><span class="text-[10px] text-emerald-50 block">${qtLeftTxt(qtDaysBetween(qtDay(), q.collectEnd))}</span></div>
      <div class="rounded-2xl bg-white/15 py-2"><span class="text-[10px] text-emerald-100 block">موعد الفعالية</span><b class="text-xs block">${qtFmtDate(q.eventStart)}</b><span class="text-[10px] text-emerald-50 block">${qtEvTxt(q)}</span></div></div>
    ${mine && myDue > 0 ? `<div class="rounded-2xl bg-white p-3 text-slate-800 flex items-center justify-between gap-3"><div class="text-xs"><span class="text-slate-500">المتبقي عليك</span><b class="block text-base text-rose-600">${fmtNum(myDue)} ريال</b></div></div>` : ''}
    ${mine && myDue <= 0 && share > 0 ? '<div class="rounded-2xl bg-white/15 p-3 text-center text-xs font-bold">تم تسديد حصتك ✓</div>' : ''}
    ${memberBtns}
  </div>`;

  const pendN = admin ? qtPendingCount() + QT.invAdmin.length : 0;
  const tabs = [['overview', 'fa-house', 'الرئيسية', 0], ['people', 'fa-users', 'المشاركون', pendN], ['expenses', 'fa-receipt', 'المصروفات', 0], ['more', 'fa-ellipsis', 'المزيد', 0]];
  const bar = `<div class="grid grid-cols-4 gap-1.5 p-1.5 bg-white/95 backdrop-blur rounded-2xl border border-slate-100 shadow-sm sticky top-2 z-10">${tabs.map(([k, ic, lb, n]) => `<button type="button" class="relative py-2 rounded-xl text-[11px] font-bold flex flex-col items-center gap-0.5 ${QT.tab === k ? 'bg-emerald-600 text-white' : 'text-slate-500'}" data-act="qt-tab" data-v="${k}"><i class="fa-solid ${ic}"></i>${lb}${n ? `<span class="absolute -top-1 -left-1 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] flex items-center justify-center">${n}</span>` : ''}</button>`).join('')}</div>`;

  const body = QT.tab === 'people' ? qtPeopleTab(q, admin)
    : QT.tab === 'expenses' ? qtExpensesTab(q, admin, staff)
    : QT.tab === 'more' ? qtMoreTab(q, admin)
    : qtOverviewTab(q, admin, st, hero);

  return `<div class="space-y-4 max-w-2xl mx-auto">
    <div class="flex items-center gap-3"><button type="button" class="w-10 h-10 rounded-xl bg-white border border-slate-200 flex-none" data-act="go-home" aria-label="رجوع"><i class="fa-solid fa-arrow-right"></i></button>
      <div class="jicon"><i class="fa-solid fa-hand-holding-dollar"></i></div>
      <div class="min-w-0"><h2 class="font-black text-lg truncate">${esc(q.name)}</h2><p class="text-[11px] text-slate-500 truncate"><span class="text-emerald-700 font-bold">قطة</span> • ${fmtNum(tg)} ريال • ${(q.memberUids || []).length}/${q.participants} أعضاء</p></div></div>
    ${bar}${body}</div>`;
}

const qtLeftTxt = d => d < 0 ? 'انتهى الموعد' : d === 0 ? 'اليوم آخر يوم' : `متبقي ${d} يوم`;
const qtEvTxt = q => qtDay() > q.eventEnd ? 'انتهت' : qtDay() >= q.eventStart ? 'جارية الآن' : `بعد ${qtDaysBetween(qtDay(), q.eventStart)} يوم`;
const qtCopyBtn = (v, lbl) => `<button type="button" data-act="qt-copy-text" data-v="${esc(v)}" class="flex-none px-2 py-1 rounded-lg bg-white border border-slate-200 text-[11px] font-bold text-teal-700" aria-label="نسخ ${lbl}"><i class="fa-regular fa-copy"></i> نسخ</button>`;

function qtOverviewTab(q, admin, st, hero) {
  const tg = qtNum(q.target), coll = qtNum(q.collected), share = qtShare(q);
  const spent = r2(QT.expenses.reduce((t, e) => t + qtNum(e.amount), 0)), left = r2(coll - spent);
  const info = [['الهدف', fmtNum(tg) + ' ريال'], ['حصة الفرد', fmtNum(share) + ' ريال'], ['عدد الأفراد', q.participants + ' شخصاً'],
    ['بداية الجمع', qtFmtDate(q.collectStart)], ['آخر موعد للجمع', qtFmtDate(q.collectEnd)], ['الفعالية', qtFmtDate(q.eventStart) + ' – ' + qtFmtDate(q.eventEnd)]];
  const money = [['المحصّل', coll, ''], ['المصاريف', spent, 'text-rose-600'], ['المتبقي بعد المصاريف', left, left < 0 ? 'text-rose-600' : 'text-emerald-700']];
  const bankName = q.adminBank ? (String(q.adminBank).startsWith('كاش') ? 'كاش' : q.adminBank) : '';
  const acct = [
    q.adminIban ? `<div class="flex items-center justify-between gap-2 p-3 bg-slate-50 rounded-xl"><div class="min-w-0"><p class="text-[10px] text-slate-500">${esc(bankName || 'الآيبان')}</p><b class="text-xs block truncate" dir="ltr">${esc(q.adminIban)}</b></div>${qtCopyBtn(q.adminIban, 'الآيبان')}</div>` : '',
    q.adminPhone ? `<div class="flex items-center justify-between gap-2 p-3 bg-slate-50 rounded-xl"><div class="min-w-0"><p class="text-[10px] text-slate-500">الجوال</p><b class="text-xs block" dir="ltr">${esc(q.adminPhone)}</b></div>${qtCopyBtn(q.adminPhone, 'الجوال')}</div>` : ''
  ].join('');
  return hero + (admin ? '' : qtMyBox())
    + qtBox('<i class="fa-solid fa-lightbulb text-amber-500"></i> الحالة الآن', `<p class="text-xs text-slate-600 leading-relaxed">${qtAdvice(q, st)}</p>`)
    + qtBox('<i class="fa-solid fa-scale-balanced text-emerald-600"></i> المصاريف والمتبقي', `<div class="grid grid-cols-3 gap-2 text-center">${money.map(([t, v, c]) => `<div class="p-2.5 bg-slate-50 rounded-xl"><p class="text-[10px] text-slate-500">${t}</p><b class="text-sm block ${c}">${fmtNum(v)}</b></div>`).join('')}</div>
      <div class="bar"><i style="width:${qtPct(spent, coll)}%;${spent > coll ? 'background:var(--loss)' : ''}"></i></div>
      ${spent > coll ? `<p class="text-[11px] text-rose-600">المصروف تجاوز المحصّل بمقدار ${fmtNum(spent - coll)} ريال.</p>` : ''}`)
    + qtBox('<i class="fa-solid fa-building-columns text-teal-700"></i> حساب المشرف للتحويل', acct || '<p class="text-xs text-slate-500">لم يضف المشرف حساب التحويل بعد.</p>')
    + qtBox('<i class="fa-solid fa-circle-info text-emerald-600"></i> تفاصيل القطة', `<div class="grid grid-cols-2 gap-2">${info.map(([t, v]) => qtTile(t, esc(v))).join('')}</div>`)
    + qtBox('<i class="fa-solid fa-user-tie text-indigo-600"></i> الإدارة', `<div class="grid grid-cols-2 gap-2">${qtTile('المشرف', esc(q.adminName || '—'))}${qtTile('النائب', q.deputyUid ? esc(q.deputyName || '—') : 'لم يُعيّن')}</div>`);
}

function qtPeopleTab(q, admin) {
  const share = qtShare(q), me = state.user.uid;
  const rows = QT.members.map((m, i) => {
    const paid = qtNum(m.paid), cr = qtNum(m.credit), cov = paid + cr;
    const full = share > 0 && cov >= share, part = cov > 0 && !full;
    const roleTag = m.uid === q.adminUid ? '<span class="text-[10px] text-indigo-600">(مشرف)</span>' : m.uid === q.deputyUid ? '<span class="text-[10px] text-amber-600">(نائب المشرف)</span>' : '';
    const pay = full ? ['تم السداد', 'bg-emerald-100 text-emerald-700'] : part ? ['سداد جزئي', 'bg-orange-100 text-orange-700'] : ['لم يسدد', 'bg-rose-100 text-rose-700'];
    const contact = m.phone ? `<p class="text-[10px] text-slate-500"><span dir="ltr">${esc(m.phone)}</span></p>` : '';
    const tools = admin ? `<button type="button" data-act="qt-paid" data-uid="${esc(m.uid)}" class="${full ? 'px-2 py-1 bg-slate-100 text-slate-600 rounded-lg' : 'px-2 py-1 bg-emerald-600 text-white rounded-lg font-bold'}">${full ? 'إلغاء السداد النقدي' : 'تسجيل سداد نقدي'}</button>
      <button type="button" data-act="qt-pay" data-uid="${esc(m.uid)}" class="px-2 py-1 bg-slate-100 text-slate-600 rounded-lg" aria-label="تعديل المدفوع"><i class="fa-solid fa-pen"></i></button>
      ${!full && m.phone && m.uid !== me ? `<a href="${waLink(m.phone, qtRemindText(q, m, share - cov))}" target="_blank" rel="noopener" class="px-2 py-1 bg-emerald-50 text-emerald-700 rounded-lg" aria-label="تذكير عبر واتساب"><i class="fa-brands fa-whatsapp"></i></a>` : ''}
      ${m.uid !== q.adminUid ? `<button type="button" data-act="qt-rm" data-uid="${esc(m.uid)}" class="px-2 py-1 bg-rose-50 text-rose-600 rounded-lg" aria-label="إزالة المشارك"><i class="fa-solid fa-user-minus"></i></button>` : ''}` : '';
    return `<div class="p-3 bg-slate-50 border border-slate-100 rounded-xl flex flex-wrap justify-between items-center gap-2 text-xs">
      <div class="flex items-center gap-3 min-w-0"><span class="w-7 h-7 rounded-full bg-emerald-100 text-emerald-800 font-bold flex items-center justify-center">${i + 1}</span>
        <div class="min-w-0"><p class="font-bold">${esc(m.name || '—')} ${roleTag}${m.uid === me ? ' <span class="text-[10px] text-emerald-600">(أنت)</span>' : ''}</p>${contact}
          <p class="text-[10px] text-slate-500">مدفوع ${fmtNum(paid)}${cr ? ' • مصروف معتمد ' + fmtNum(cr) : ''} من ${fmtNum(share)} ريال</p></div></div>
      <div class="flex items-center gap-2 flex-wrap"><span class="px-2 py-1 rounded-lg font-bold ${pay[1]}">${pay[0]}</span>${tools}</div></div>`;
  }).join('');
  const head = `<div class="flex justify-between items-center"><span><i class="fa-solid fa-users text-emerald-600"></i> المشاركون</span><span class="text-xs bg-slate-100 px-2 py-1 rounded-lg font-semibold">${QT.members.length}/${q.participants}</span></div>`;
  return (admin ? qtReviewCard(q) : '') + qtBox(head, `<div class="space-y-2">${rows || qtEmpty('لا يوجد مشاركون بعد')}</div>`) + (admin ? qtAdminPanels(q) : '');
}

function qtAdminPanels(q) {
  const free = Math.max(0, qtNum(q.participants) - (q.memberUids || []).length - QT.invAdmin.length);
  const opts = QT.members.filter(m => m.uid !== q.adminUid).map(m => `<option value="${esc(m.uid)}" ${m.uid === q.deputyUid ? 'selected' : ''}>${esc(m.name || '—')}</option>`).join('');
  const inv = QT.invAdmin.map(i => `<div class="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs flex flex-wrap items-center justify-between gap-2">
      <div class="min-w-0"><p class="font-bold">${esc(i.invitedName || '—')}</p><p class="text-slate-600" dir="ltr">${esc(i.phone || i.email || '')}</p></div>
      <div class="flex gap-1.5"><button type="button" class="btn b-pri" data-act="qt-inv-share" data-id="${esc(i.id)}"><i class="fa-brands fa-whatsapp"></i> إرسال</button>
      <button type="button" class="btn b-red" data-act="qt-inv-cancel" data-id="${esc(i.id)}">إلغاء</button></div></div>`).join('');
  return qtBox('<i class="fa-solid fa-user-plus text-teal-700"></i> إضافة مشارك <span class="text-[11px] font-normal text-slate-500">(متبقٍ ' + free + ' مكان)</span>', `
      <form id="f-qt-add" class="space-y-3">
        <div class="grid md:grid-cols-2 gap-3"><input name="mname" class="inp" required maxlength="40" placeholder="الاسم"><input name="mcontact" class="inp" required dir="ltr" placeholder="05xxxxxxxx أو البريد"></div>
        <p class="text-[11px] text-slate-500 leading-relaxed">إن كان الجوال مسجلاً في التطبيق يُضاف مباشرة ويظهر له التعاون عند دخوله. وإن لم يكن مسجلاً أو كان بريداً، تُرسل له دعوة يقبلها من حسابه.</p>
        <button class="btn b-pri w-full" type="submit">إضافة</button></form>`)
    + qtBox('<i class="fa-solid fa-user-shield text-amber-600"></i> نائب المشرف', `
      <form id="f-qt-deputy" class="flex flex-wrap items-end gap-2"><div class="flex-1 min-w-[10rem]"><label class="text-xs font-semibold block mb-1">يسجّل المصروفات مع المشرف</label>
        <select name="duid" class="inp"><option value="">بدون نائب</option>${opts}</select></div><button class="btn b-pri" type="submit">حفظ</button></form>`)
    + qtBox('<i class="fa-solid fa-clock-rotate-left text-amber-500"></i> دعوات معلّقة', inv || qtEmpty('لا توجد دعوات معلّقة.'));
}

function qtExpensesTab(q, admin, staff) {
  const coll = qtNum(q.collected), tg = qtNum(q.target);
  if (!qtUnlocked(q)) return qtBox('<i class="fa-solid fa-lock text-slate-400"></i> المصروفات مقفلة',
    `<p class="text-xs text-slate-500 leading-relaxed">تُفتح تلقائياً عند اكتمال المبلغ المستهدف (${fmtNum(tg)} ريال)، وباقي ${fmtNum(Math.max(0, tg - coll))} ريال.</p>`
    + (admin ? '<button type="button" class="btn b-sec w-full" data-act="qt-unlock"><i class="fa-solid fa-lock-open"></i> فتح المصروفات مبكراً</button>' : ''));
  const spent = r2(QT.expenses.reduce((t, e) => t + qtNum(e.amount), 0)), left = r2(coll - spent), spentPct = qtPct(spent, coll);
  const summary = qtBox('<i class="fa-solid fa-scale-balanced text-emerald-600"></i> الملخص المالي', `
    <div class="grid grid-cols-3 gap-2 text-center">${[['المحصّل', coll, ''], ['المصروف', spent, ''], ['المتبقي', left, left < 0 ? 'text-rose-600' : '']].map(([t, v, c]) => `<div class="p-2.5 bg-slate-50 rounded-xl"><p class="text-[10px] text-slate-500">${t}</p><b class="text-sm ${c}">${fmtNum(v)}</b></div>`).join('')}</div>
    <div class="bar"><i style="width:${spentPct}%;${spent > coll ? 'background:var(--loss)' : ''}"></i></div>
    ${spent > coll ? `<p class="text-[11px] text-rose-600">المصروف تجاوز المحصّل بمقدار ${fmtNum(spent - coll)} ريال.</p>` : ''}`);
  const form = staff ? qtBox('<i class="fa-solid fa-receipt text-emerald-600"></i> تسجيل مصروف', `
    <form id="f-qt-exp" class="space-y-3"><div class="grid md:grid-cols-3 gap-3"><input name="ename" class="inp" required maxlength="80" placeholder="البند: فندق، وقود، ضيافة"><input name="eamount" type="number" min="0.01" step="any" class="inp" required placeholder="المبلغ (ريال)"><input name="edate" type="date" class="inp" required value="${qtDay()}"></div>
    <button class="btn b-pri w-full" type="submit">إضافة المصروف</button></form>`) : '';
  const rows = QT.expenses.map(e => `<div class="p-3 bg-slate-50 border border-slate-100 rounded-xl flex justify-between items-center gap-2 text-xs">
      <div class="min-w-0"><p class="font-bold truncate">${esc(e.name)}</p><p class="text-[10px] text-slate-500">${qtFmtDate(e.date)} • ${esc(e.byName || '—')}</p></div>
      <div class="flex items-center gap-2 flex-none"><b class="text-sm">${fmtNum(e.amount)} ريال</b>${(e.forUid ? admin : staff) ? `<button type="button" data-act="qt-exp-del" data-id="${esc(e.id)}" class="px-2 py-1 bg-rose-50 text-rose-600 rounded-lg" aria-label="حذف المصروف"><i class="fa-solid fa-trash-can"></i></button>` : ''}</div></div>`).join('');
  return summary + form + qtBox(`<i class="fa-solid fa-list text-slate-500"></i> المصروفات (${QT.expenses.length})`, `<div class="space-y-2">${rows || qtEmpty('لا توجد مصروفات مسجّلة بعد')}</div>`);
}

function qtMoreTab(q, admin) {
  if (!admin) return qtBox('<i class="fa-solid fa-circle-info text-slate-500"></i> عن القطة', '<p class="text-xs text-slate-500 leading-relaxed">أنت مشارك في هذه القطة. المشرف وحده يدير السداد والأعضاء والإعدادات.</p>');
  return qtBox('<i class="fa-solid fa-user-gear text-indigo-600"></i> أدوات المشرف', `<div class="grid grid-cols-2 gap-2">
      <button type="button" class="btn b-sec" data-act="qt-edit"><i class="fa-solid fa-pen"></i> تعديل القطة</button>
      <button type="button" class="btn b-sec" data-act="qt-unlock"><i class="fa-solid ${q.expOpen ? 'fa-lock' : 'fa-lock-open'}"></i> ${q.expOpen ? 'قفل المصروفات' : 'فتح المصروفات مبكراً'}</button>
      <button type="button" class="btn b-red col-span-2" data-act="qt-del"><i class="fa-solid fa-trash"></i> حذف القطة نهائياً</button></div>`);
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
  b.set(ref, { ...v, ...qtAcctOf(p), adminUid: uid, adminName: dispName(p), deputyUid: '', deputyName: '', memberUids: [uid], collected: 0, expOpen: false, createdAt: FV.serverTimestamp() });
  b.set(ref.collection('members').doc(uid), qtMemberDoc(uid, dispName(p), p.phone, true));
  try { await b.commit(); toast('تم إنشاء القطة'); wzDone('qattah', ref.id, v.name); }
  catch (e) { toast('تعذر الإنشاء: ' + e.message, 'error'); }
}
function qtOpenEdit() { const q = QT.q; if (!q || !qtAdminOf(q)) return; showModal('تعديل القطة', qtFormHtml(q, 'edit')); }
async function qtEditSubmit(f) {
  const q = QT.q; if (!q || !qtAdminOf(q) || f.qid.value !== q.id) return;
  const v = qtReadForm(f, false); if (!v) return;
  if (QT.members.length > v.participants) return toast('عدد المشاركين أقل من الأعضاء الحاليين', 'error');
  try { await qtRef(q.id).update({ ...v, ...qtAcctOf(state.profile) }); closeModal(); toast('حُفظت التعديلات'); }
  catch (e) { toast('تعذر الحفظ: ' + e.message, 'error'); }
}
async function qtDelete() {
  const q = QT.q; if (!q || !qtAdminOf(q)) return;
  if (!confirm(`حذف القطة «${q.name}» نهائياً مع مشاركيها ومصروفاتها وطلباتها؟`)) return;
  try {
    const me = state.user.uid, base = qtRef(q.id), refs = [];
    const [m, e, iv, cl, rq] = await Promise.all([
      base.collection('members').get(), base.collection('expenses').get(),
      db.collection(QT_INV).where('qid', '==', q.id).where('adminUid', '==', me).get(),
      base.collection('claims').get(), base.collection('expReqs').get()]);
    [m, e, iv, cl, rq].forEach(s => s.docs.forEach(d => refs.push(d.ref)));
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
      try { await b.commit(); f.reset(); toast(`أُضيف ${name} مباشرة، وسيرى القطة في حسابه عند دخوله`); sendNotifs([uid], 'أُضفت إلى قطة', `${dispName(state.profile)} أضافك إلى قطة «${q.name}»`, qtJid(q.id), 'qattah'); }
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
  try { await b.commit(); toast('تم قبول الدعوة'); sendNotifs([i.adminUid], 'مشارك جديد في القطة', `${dispName(p)} انضم إلى قطة «${i.qName || ''}»`, qtJid(i.qid), 'qattah'); qtOpen(i.qid); }
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
  const cov = paid + qtNum(m.credit);
  if (cov) upd.collected = FV.increment(-cov);
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
  try { await b.commit(); if (delta > 0) sendNotifs([uid], 'تم تسجيل سدادك ✓', `قطة «${q.name}» — ${fmtNum(delta)} ريال`, qtJid(q.id), 'qattah', 'qp_' + q.id + '_' + uid + '_' + Date.now()); }
  catch (e) { toast('تعذر حفظ السداد: ' + e.message, 'error'); }
}
function qtTogglePaid(uid) {
  const q = QT.q, m = QT.members.find(x => x.uid === uid); if (!q || !m) return;
  const share = qtShare(q), full = share > 0 && qtCovered(m) >= share;
  qtSetPaid(uid, full ? 0 : r2(Math.max(0, share - qtNum(m.credit))));
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
  try { await qtRef(q.id).update({ expOpen: !q.expOpen }); toast(q.expOpen ? 'أُقفلت المصروفات' : 'فُتحت المصروفات', 'info'); if (!q.expOpen) sendNotifs(q.memberUids, 'فُتحت مصروفات القطة', `يمكنك إرسال طلب مصروف في قطة «${q.name}»`, qtJid(q.id), 'qattah'); }
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
    f.reset(); f.edate.value = qtDay(); toast('أُضيف المصروف'); sendNotifs(q.memberUids, 'مصروف جديد في القطة', `قطة «${q.name}» — ${name}: ${fmtNum(amount)} ريال`, qtJid(q.id), 'qattah');
  } catch (e) { toast('تعذر الحفظ: ' + e.message, 'error'); }
}
async function qtDelExp(id) {
  const q = QT.q, e = QT.expenses.find(x => x.id === id);
  if (!q || !e || !qtStaffOf(q)) return;
  if (e.forUid && !qtAdminOf(q)) return toast('المصروف المعتمد لعضو لا يحذفه إلا المشرف', 'error');
  if (!confirm(e.forUid ? 'حذف هذا المصروف؟ سيُعاد المبلغ إلى المتبقي على العضو وينقص من المحصّل.' : 'حذف هذا المصروف؟')) return;
  const ref = qtRef(q.id), b = db.batch(), amt = r2(qtNum(e.amount));
  b.delete(ref.collection('expenses').doc(id));
  if (e.forUid && QT.members.some(m => m.uid === e.forUid)) {
    // المصروف المعتمد كان محسوباً مقدّماً من العضو، فيُعاد احتسابه
    b.update(ref.collection('members').doc(e.forUid), { credit: FV.increment(-amt) });
    b.update(ref, { collected: FV.increment(-amt) });
  }
  try { await b.commit(); toast('حُذف المصروف', 'info'); }
  catch (err) { toast('تعذر الحذف: ' + err.message, 'error'); }
}

/* ---------- تأكيد السداد وطلبات المصروف ---------- */
const qtCovered = m => qtNum(m.paid) + qtNum(m.credit);
const qtDue = (q, m) => Math.max(0, qtShare(q) - qtCovered(m));
const qtPendingCount = () => QT.claims.filter(c => c.status === 'pending').length + QT.reqs.filter(r => r.status === 'pending').length;
const qtStLabel = s => ({ pending: ['بانتظار المراجعة', 'bg-sky-100 text-sky-700'], confirmed: ['مؤكد', 'bg-emerald-100 text-emerald-700'], approved: ['معتمد', 'bg-emerald-100 text-emerald-700'], rejected: ['مرفوض', 'bg-rose-100 text-rose-700'] })[s] || ['—', 'bg-slate-100 text-slate-500'];

// قسم العضو: طلباته وحالتها
function qtMyBox() {
  const items = [
    ...QT.claims.map(c => ({ k: 'claim', t: 'تأكيد سداد', title: 'سداد للقطة', a: c.amount, s: c.status, id: c.id, ts: c.createdAt })),
    ...QT.reqs.map(r => ({ k: 'req', t: 'طلب مصروف', title: r.title, a: r.amount, s: r.status, id: r.id, ts: r.createdAt }))
  ].sort((x, y) => qtTs(y.ts) - qtTs(x.ts));
  const rows = items.map(it => {
    const [lb, cl] = qtStLabel(it.s);
    return `<div class="p-3 bg-slate-50 border border-slate-100 rounded-xl flex flex-wrap justify-between items-center gap-2 text-xs">
      <div class="min-w-0"><p class="font-bold">${esc(it.title || '')} <span class="text-[10px] text-slate-500">• ${it.t}</span></p><p class="text-[10px] text-slate-500">${fmtNum(it.a)} ريال</p></div>
      <div class="flex items-center gap-2"><span class="px-2 py-1 rounded-lg font-bold ${cl}">${lb}</span>
        ${it.s === 'pending' ? `<button type="button" class="px-2 py-1 bg-rose-50 text-rose-600 rounded-lg" data-act="qt-item-cancel" data-k="${it.k}" data-id="${esc(it.id)}" aria-label="إلغاء الطلب"><i class="fa-solid fa-xmark"></i></button>` : ''}</div></div>`;
  }).join('');
  return qtBox('<i class="fa-solid fa-clipboard-list text-emerald-600"></i> طلباتي ومساهماتي', rows || qtEmpty('لم ترسل أي طلب بعد. استخدم الأزرار أعلاه لتأكيد سدادك أو طلب إضافة مصروف.'));
}

// قسم المشرف: الطلبات بانتظار المراجعة
function qtReviewCard(q) {
  const pc = QT.claims.filter(c => c.status === 'pending'), pr = QT.reqs.filter(r => r.status === 'pending');
  const head = `<i class="fa-solid fa-inbox text-sky-600"></i> طلبات بانتظار المراجعة (${pc.length + pr.length})`;
  if (!pc.length && !pr.length) return qtBox(head, qtEmpty('لا توجد طلبات بانتظار المراجعة 👌'));
  const cRow = c => `<div class="p-3 bg-sky-50 border border-sky-100 rounded-xl text-xs flex flex-wrap justify-between items-center gap-2">
      <div class="min-w-0"><p class="font-bold">${esc(c.name || '')} <span class="text-[10px] text-sky-700">• تأكيد سداد</span></p>
        <p class="text-[10px] text-slate-500">${fmtNum(c.amount)} ريال${c.ref ? ' • مرجع: <span dir="ltr">' + esc(c.ref) + '</span>' : ''}</p></div>
      <div class="flex gap-1.5"><button type="button" class="btn bg-emerald-600 text-white" data-act="qt-claim-ok" data-id="${esc(c.id)}"><i class="fa-solid fa-check"></i> تأكيد</button>
        <button type="button" class="btn b-red" data-act="qt-claim-no" data-id="${esc(c.id)}">رفض</button></div></div>`;
  const rRow = r => `<div class="p-3 bg-amber-50 border border-amber-100 rounded-xl text-xs space-y-2">
      <div class="flex flex-wrap justify-between items-center gap-2"><div class="min-w-0"><p class="font-bold">${esc(r.title || '')} <span class="text-[10px] text-amber-700">• طلب مصروف من ${esc(r.name || '')}</span></p>
        <p class="text-[10px] text-slate-500">${fmtNum(r.amount)} ريال • ${qtFmtDate(r.date)}</p></div>
        <div class="flex gap-1.5"><button type="button" class="btn bg-emerald-600 text-white" data-act="qt-req-ok" data-id="${esc(r.id)}"><i class="fa-solid fa-check"></i> اعتماد</button>
          <button type="button" class="btn b-red" data-act="qt-req-no" data-id="${esc(r.id)}">رفض</button></div></div>
      ${r.details ? `<p class="text-[11px] text-slate-600 leading-relaxed">${esc(r.details)}</p>` : ''}</div>`;
  return qtBox(head, [...pc.map(cRow), ...pr.map(rRow)].join('<div class="h-px bg-slate-100"></div>'));
}

function qtOpenClaim() {
  const q = QT.q, m = QT.members.find(x => x.uid === state.user.uid); if (!q || !m) return;
  const due = qtDue(q, m);
  showModal('تأكيد السداد', `<form id="f-qt-claim" class="space-y-3">
    <p class="text-xs text-slate-500 leading-relaxed">أدخل المبلغ الذي حوّلته للمشرف. لا يُحتسب في القطة إلا بعد تأكيده.</p>
    <div><label class="text-xs font-semibold block mb-1">المبلغ (ريال)</label><input name="camount" type="number" min="1" step="any" class="inp" required value="${due || ''}"></div>
    <div><label class="text-xs font-semibold block mb-1">رقم المرجع (اختياري)</label><input name="cref" class="inp" maxlength="60" dir="ltr"></div>
    <button class="btn b-pri w-full py-3" type="submit">إرسال للمشرف للتأكيد</button></form>`);
}
async function qtSaveClaim(f) {
  const q = QT.q, m = QT.members.find(x => x.uid === state.user.uid); if (!q || !m) return;
  const amount = r2(parseFloat(f.camount.value)), ref = f.cref.value.trim();
  if (!(amount > 0)) return toast('المبلغ غير صحيح', 'error');
  try {
    await qtRef(q.id).collection('claims').add({ uid: state.user.uid, name: (m.name || '').slice(0, 60), amount, ref, status: 'pending', createdAt: FV.serverTimestamp() });
    closeModal(); toast('أُرسل للمشرف للتأكيد'); sendNotifs(qtStaffUids(q), 'طلب تأكيد سداد في القطة', `${(m.name || dispName(state.profile))} — قطة «${q.name}» — ${fmtNum(amount)} ريال`, qtJid(q.id), 'qattah');
  } catch (e) { toast('تعذر الإرسال: ' + e.message, 'error'); }
}
function qtOpenReq() {
  const q = QT.q; if (!q || !QT.members.some(m => m.uid === state.user.uid)) return;
  const lbl = 'text-xs font-semibold block mb-1';
  showModal('طلب إضافة مصروف', `<form id="f-qt-req" class="space-y-3">
    <p class="text-xs text-slate-500 leading-relaxed">صرفت من مالك على بند من بنود القطة؟ أرسل التفاصيل للمشرف. عند اعتماده يُحتسب المبلغ مقدّماً منك ويُخصم من المتبقي عليك.</p>
    <div><label class="${lbl}">البند</label><input name="rtitle" class="inp" required maxlength="80" placeholder="مثال: تذاكر، ضيافة، وقود"></div>
    <div class="grid grid-cols-2 gap-3"><div><label class="${lbl}">المبلغ (ريال)</label><input name="ramount" type="number" min="0.01" step="any" class="inp" required></div>
      <div><label class="${lbl}">التاريخ</label><input name="rdate" type="date" class="inp" required value="${qtDay()}"></div></div>
    <div><label class="${lbl}">التفاصيل</label><textarea name="rdetails" rows="3" class="inp" maxlength="300" placeholder="ماذا اشتريت ولماذا؟"></textarea></div>
    <button class="btn b-pri w-full py-3" type="submit">إرسال الطلب للمشرف</button></form>`);
}
async function qtSaveReq(f) {
  const q = QT.q, m = QT.members.find(x => x.uid === state.user.uid); if (!q || !m) return;
  const title = f.rtitle.value.trim(), amount = r2(parseFloat(f.ramount.value)), date = f.rdate.value, details = f.rdetails.value.trim();
  if (!title) return toast('اكتب البند', 'error');
  if (!(amount > 0)) return toast('المبلغ غير صحيح', 'error');
  if (!qtDateOk(date)) return toast('حدد التاريخ', 'error');
  try {
    await qtRef(q.id).collection('expReqs').add({ uid: state.user.uid, name: (m.name || '').slice(0, 60), title, details, amount, date, status: 'pending', createdAt: FV.serverTimestamp() });
    closeModal(); toast('أُرسل الطلب للمشرف'); sendNotifs(qtStaffUids(q), 'طلب مصروف جديد في القطة', `${(m.name || dispName(state.profile))} — قطة «${q.name}» — ${title}: ${fmtNum(amount)} ريال`, qtJid(q.id), 'qattah');
  } catch (e) { toast('تعذر الإرسال: ' + e.message, 'error'); }
}

// اعتماد سداد: يُضاف إلى مدفوع العضو والمحصّل، ويُغلق الطلب
async function qtDecideClaim(id, ok) {
  const q = QT.q, c = QT.claims.find(x => x.id === id);
  if (!q || !c || !qtAdminOf(q) || c.status !== 'pending') return;
  const ref = qtRef(q.id), b = db.batch(), amt = r2(qtNum(c.amount));
  b.update(ref.collection('claims').doc(id), { status: ok ? 'confirmed' : 'rejected', decidedAt: FV.serverTimestamp() });
  if (ok) {
    if (!QT.members.some(m => m.uid === c.uid)) return toast('العضو لم يعد في القطة', 'error');
    b.update(ref.collection('members').doc(c.uid), { paid: FV.increment(amt) });
    b.update(ref, { collected: FV.increment(amt) });
  }
  try { await b.commit(); toast(ok ? 'تم تأكيد السداد' : 'رُفض طلب السداد', 'info'); sendNotifs([c.uid], ok ? 'تم تأكيد سدادك ✓' : 'لم يُقبل طلب السداد', `قطة «${q.name}» — ${fmtNum(amt)} ريال`, qtJid(q.id), 'qattah'); }
  catch (e) { toast('تعذر الحفظ: ' + e.message, 'error'); }
}

// اعتماد مصروف: يُسجَّل في المصروفات، ويُحتسب مقدّماً من العضو (يُخصم من المتبقي عليه)
async function qtDecideReq(id, ok) {
  const q = QT.q, r = QT.reqs.find(x => x.id === id);
  if (!q || !r || !qtAdminOf(q) || r.status !== 'pending') return;
  if (ok && !QT.members.some(m => m.uid === r.uid)) return toast('العضو لم يعد في القطة', 'error');
  const ref = qtRef(q.id), b = db.batch(), amt = r2(qtNum(r.amount));
  b.update(ref.collection('expReqs').doc(id), { status: ok ? 'approved' : 'rejected', decidedAt: FV.serverTimestamp() });
  if (ok) {
    b.set(ref.collection('expenses').doc(), { name: r.title, amount: amt, date: r.date, uid: state.user.uid, byName: dispName(state.profile), forUid: r.uid, byMember: (r.name || '').slice(0, 60), details: (r.details || '').slice(0, 300), createdAt: FV.serverTimestamp() });
    b.update(ref.collection('members').doc(r.uid), { credit: FV.increment(amt) });
    b.update(ref, { collected: FV.increment(amt) });
  }
  try { await b.commit(); toast(ok ? 'اعتُمد المصروف وخُصم من المتبقي على العضو' : 'رُفض طلب المصروف', 'info'); sendNotifs([r.uid], ok ? 'اعتُمد طلب مصروفك ✓' : 'لم يُقبل طلب المصروف', `قطة «${q.name}» — ${r.title}: ${fmtNum(amt)} ريال`, qtJid(q.id), 'qattah'); }
  catch (e) { toast('تعذر الحفظ: ' + e.message, 'error'); }
}

async function qtCancelItem(k, id) {
  const q = QT.q; if (!q) return;
  if (!confirm('إلغاء هذا الطلب؟')) return;
  try { await qtRef(q.id).collection(k === 'claim' ? 'claims' : 'expReqs').doc(id).delete(); toast('أُلغي الطلب', 'info'); }
  catch (e) { toast('تعذر الإلغاء: ' + e.message, 'error'); }
}

/* ---------- ربط الأحداث بالتطبيق الرئيسي ---------- */
const QT_ACTIONS = {
  'go-create-family': () => wzStart('family'),
  'qt-new': () => { qtLeave(); wzStart('qattah'); },
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
  'qt-copy': () => copyText(QT.shareText || '', 'تم نسخ نص الدعوة'),
  'qt-copy-text': el => copyText(el.dataset.v || '', 'تم النسخ'),
  'qt-claim-modal': () => qtOpenClaim(),
  'qt-req-modal': () => qtOpenReq(),
  'qt-claim-ok': el => qtDecideClaim(el.dataset.id, true),
  'qt-claim-no': el => qtDecideClaim(el.dataset.id, false),
  'qt-req-ok': el => qtDecideReq(el.dataset.id, true),
  'qt-req-no': el => qtDecideReq(el.dataset.id, false),
  'qt-item-cancel': el => qtCancelItem(el.dataset.k, el.dataset.id)
};
const QT_FORMS = {
  'f-qat-create': qtCreate,
  'f-qat-edit': qtEditSubmit,
  'f-qt-add': qtAddMember,
  'f-qt-pay': qtSavePay,
  'f-qt-exp': qtAddExpense,
  'f-qt-deputy': qtSetDeputy,
  'f-qt-claim': qtSaveClaim,
  'f-qt-req': qtSaveReq
};