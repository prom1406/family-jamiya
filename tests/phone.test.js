/* اختبارات «الجوال المعتمد»: الرقم المُدخل يُعتمد تلقائياً دون رسالة SMS.
   التشغيل:  node --test tests/*.test.js
   تُحمَّل الدوال الحقيقية من index.html (لا نسخة منها). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const a = html.indexOf('const lc = '), b = html.indexOf('const normPhone'), c = html.indexOf('const isVerified');
assert.ok(a > 0 && b > a && c > b, 'تعذر استخراج دوال الجوال من index.html');
const src = html.slice(b, html.indexOf('\n', c)); // normPhone ... isVerified
const mk = state => {
  const ctx = vm.createContext({ state, console });
  vm.runInContext(html.slice(a, html.indexOf('\n', a)) + '\n' + src + '\nthis.f = { phone05FromUser, accountPhone05, mailPhone05, isVerified, validPhone, normPhone };', ctx);
  return ctx.f;
};
const U = { uid: 'u1', emailVerified: false, email: 'a@x.com' };

test('الجوال المُدخل في الملف الشخصي يُعتمد دون رسالة', () => {
  const f = mk({ user: U, profile: { phone: '0555555555' } });
  assert.equal(f.phone05FromUser(U), '0555555555');
  assert.equal(f.isVerified(U), true);                  // بريد غير مفعّل لكن الجوال معتمد
});
test('الأرقام العربية في الملف الشخصي تُطبَّع', () => {
  const f = mk({ user: U, profile: { phone: '٠٥٥٥٥٥٥٥٥٥' } });
  assert.equal(f.phone05FromUser(U), '0555555555');
});
test('بلا جوال في الملف ولا حساب قديم: غير معتمد (تظهر بوابة إدخال الجوال)', () => {
  const f = mk({ user: U, profile: { phone: '' } });
  assert.equal(f.phone05FromUser(U), '');
  assert.equal(f.isVerified(U), false);
  assert.equal(mk({ user: U, profile: { phone: '12345' } }).phone05FromUser(U), '');
});
test('الرقم المحجوز لحساب آخر لا يُعتمد', () => {
  const f = mk({ user: U, profile: { phone: '0555555555' }, _phoneTaken: true });
  assert.equal(f.phone05FromUser(U), '');
  assert.equal(f.isVerified(U), false);
});
test('الحسابات القديمة الموثّقة برمز SMS تبقى معتمدة', () => {
  const old = { uid: 'u2', phoneNumber: '+966501234567' };
  assert.equal(mk({ user: old, profile: null }).phone05FromUser(old), '0501234567');
  assert.equal(mk({ user: old, profile: { phone: '' } }).isVerified(old), true);
});
test('ملف مستخدم آخر لا يُنسب لهذا الحساب', () => {
  const f = mk({ user: { uid: 'other' }, profile: { phone: '0555555555' } });
  assert.equal(f.phone05FromUser(U), '');
});
test('رقم التسجيل بالجوال يُستخرج من البريد الداخلي فقط لتعبئة الملف عند الإنشاء', () => {
  const f = mk({ user: null, profile: null });
  assert.equal(f.accountPhone05({ email: '0555555555@phone.siwaa.app' }), '0555555555');
  assert.equal(f.accountPhone05({ email: 'a@gmail.com' }), '');
  assert.equal(f.accountPhone05({ email: 'x0555555555@phone.siwaa.app' }), '');
  assert.equal(f.accountPhone05({ phoneNumber: '+966501234567' }), '0501234567');
  // لا يُعتمد الجوال من البريد الداخلي وحده: الاعتماد من الملف الشخصي المحجوز فقط
  assert.equal(f.phone05FromUser({ uid: 'x', email: '0555555555@phone.siwaa.app' }), '');
});
