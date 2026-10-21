# نشر سِواء على App Store (بدون Mac)

Bundle ID: `com.prom1406.siwa`

## 1) في developer.apple.com
1. Identifiers ← App IDs ← `com.prom1406.siwa` ← فعّل **Sign in with Apple**.
2. Users and Access ← Integrations ← App Store Connect API ← أنشئ مفتاحاً (صلاحية **App Manager**) وحمّل ملف `.p8` (مرة واحدة فقط) ودوّن **Key ID** و**Issuer ID**.
3. Membership ← دوّن **Team ID**.

## 2) في App Store Connect
My Apps ← + ← New App ← iOS ← نفس الـ Bundle ID.

## 3) في Firebase (Authentication ← Sign-in method ← Apple)
فعّل مزوّد Apple. داخل التطبيق الأصلي يكفي تفعيله (بدون Services ID)، لأن التحقق يتم بالرمز المباشر.

## 4) أسرار GitHub (Settings ← Secrets and variables ← Actions)
| الاسم | القيمة |
|---|---|
| `APPLE_TEAM_ID` | Team ID |
| `ASC_KEY_ID` | Key ID |
| `ASC_ISSUER_ID` | Issuer ID |
| `ASC_KEY_P8` | كامل محتوى ملف `.p8` (بما فيه سطري BEGIN/END) |

## 5) التشغيل
Actions ← **iOS → TestFlight** ← Run workflow. بعد دقائق يظهر البناء في TestFlight، ومنه تُرسله للمراجعة.

## ملاحظات للمراجعة
- حذف الحساب متوفر في الملف الشخصي (شرط 5.1.1(v)).
- إبطال رمز Apple عند الحذف يحتاج Cloud Function (اختياري ومستحسن لاحقاً).
- أضف رابط `privacy.html` كسياسة الخصوصية، وجهّز حساب تجريبي (بريد وكلمة مرور) لفريق المراجعة.
