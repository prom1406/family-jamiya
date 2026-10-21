# نشر سِواء على App Store (بدون Mac)

Bundle ID: `com.prom1406.sewaa`

## 1) في developer.apple.com
1. Identifiers ← App IDs ← `com.prom1406.sewaa` ← فعّل **Sign in with Apple**.
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

## 6) إشعارات آبل (Push)
1. developer.apple.com ← Identifiers ← `com.prom1406.sewaa` ← فعّل **Push Notifications** ← Save.
2. Keys ← + ← فعّل **Apple Push Notifications service (APNs)** ← حمّل ملف `.p8` ودوّن **Key ID**.
3. Firebase ← إعدادات المشروع ← General ← **Add app ← iOS** بالـ Bundle ID `com.prom1406.sewaa` (لا تحتاج تنزيل أي ملف).
4. Firebase ← إعدادات المشروع ← **Cloud Messaging** ← Apple app configuration ← **APNs Authentication Key** ← Upload (ملف `.p8` + Key ID + Team ID).
5. انسخ **App ID** لتطبيق iOS (شكله `1:508199870007:ios:xxxx`) وأضفه كسر في GitHub باسم `FIREBASE_IOS_APP_ID`.
6. شغّل workflow من جديد. الـ workflow يولّد `GoogleService-Info.plist` تلقائياً، ويفشل برسالة واضحة إن غاب السر (بدلاً من بناء تطبيق ينهار).

يُطلب إذن الإشعارات تلقائياً بعد تسجيل الدخول، ويُحفظ رمز الجهاز في `users/{uid}.fcmTokens` فيستخدمه الخادم الحالي كما هو.
