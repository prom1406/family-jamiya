# يُعدّل مشروع Android الناتج من Capacitor: الإصدارات، مفتاح التوقيع، خدمات Firebase
import os, re, pathlib, sys

root = pathlib.Path('android')
app_gradle = root / 'app' / 'build.gradle'
top_gradle = root / 'build.gradle'
vars_gradle = root / 'variables.gradle'

vcode = os.environ['VERSION_CODE']
vname = os.environ['VERSION_NAME']
target_sdk = os.environ.get('TARGET_SDK', '35')

# 1) مستويات SDK و Android Gradle Plugin
COMPILE_SDK = os.environ.get('COMPILE_SDK', '36')
target_sdk = os.environ.get('TARGET_SDK', '35')
if vars_gradle.exists():
    t = vars_gradle.read_text(encoding='utf8')
    t = re.sub(r'targetSdkVersion\s*=\s*\d+', f'targetSdkVersion = {target_sdk}', t)
    t = re.sub(r'compileSdkVersion\s*=\s*\d+', f'compileSdkVersion = {COMPILE_SDK}', t)
    vars_gradle.write_text(t, encoding='utf8')
    print('variables.gradle: compileSdk =', COMPILE_SDK, 'targetSdk =', target_sdk)

rt = top_gradle.read_text(encoding='utf8')
rt2 = re.sub(r"com\.android\.tools\.build:gradle:[\d.]+", "com.android.tools.build:gradle:8.9.1", rt)
if rt2 != rt:
    top_gradle.write_text(rt2, encoding='utf8')
    print('AGP -> 8.9.1')

# 2) Google Services plugin (لإشعارات FCM و Google Sign-In)
t = top_gradle.read_text(encoding='utf8')
if 'com.google.gms:google-services' not in t:
    t, n = re.subn(r'(buildscript\s*\{[\s\S]*?dependencies\s*\{)',
                   r"\1\n        classpath 'com.google.gms:google-services:4.4.2'", t, count=1)
    assert n == 1, 'لم يُعثر على buildscript.dependencies في build.gradle'
    top_gradle.write_text(t, encoding='utf8')

a = app_gradle.read_text(encoding='utf8')
if 'com.google.gms.google-services' not in a:
    a += "\napply plugin: 'com.google.gms.google-services'\n"

# 3) رقم الإصدار
a, n1 = re.subn(r'versionCode\s+\d+', f'versionCode {vcode}', a, count=1)
a, n2 = re.subn(r'versionName\s+"[^"]*"', f'versionName "{vname}"', a, count=1)
assert n1 == 1 and n2 == 1, 'لم يُعثر على versionCode/versionName'

# 4) توقيع الإصدار: المفاتيح تُقرأ من متغيرات البيئة (لا تُكتب في الملف)
signing = """
    signingConfigs {
        release {
            storeFile file(System.getenv("KS_PATH"))
            storePassword System.getenv("KS_PASS")
            keyAlias System.getenv("KS_ALIAS")
            keyPassword System.getenv("KS_KEY_PASS")
        }
    }
"""
assert a.count('android {') >= 1
a = a.replace('android {', 'android {' + signing, 1)
a, n3 = re.subn(r'(buildTypes\s*\{\s*release\s*\{)', r'\1\n            signingConfig signingConfigs.release', a, count=1)
assert n3 == 1, 'لم يُعثر على buildTypes.release'
app_gradle.write_text(a, encoding='utf8')

print('versionCode', vcode, 'versionName', vname)

# 5) توحيد إصدار androidx.browser (تعارض بين capgo و androidbrowserhelper)
root_extra = """
allprojects {
    configurations.all {
        resolutionStrategy {
            force 'androidx.browser:browser:1.9.0'
        }
    }
}
"""
rt = top_gradle.read_text(encoding='utf8')
if 'androidx.browser:browser:1.9.0' not in rt:
    top_gradle.write_text(rt + root_extra, encoding='utf8')
# 6) رفع minSdkVersion إلى 24 (متطلب Play Automatic Protection)
MIN_SDK = os.environ.get('MIN_SDK', '24')
vt = vars_gradle.read_text(encoding='utf8')
vt2 = re.sub(r'minSdkVersion\s*=\s*\d+', f'minSdkVersion = {MIN_SDK}', vt)
if vt2 != vt:
    vars_gradle.write_text(vt2, encoding='utf8')
    print('minSdkVersion =', MIN_SDK)
    
# 7) صلاحية الإشعارات (أندرويد 13+) والقناة الافتراضية لإشعارات FCM
man = root / 'app' / 'src' / 'main' / 'AndroidManifest.xml'
m = man.read_text(encoding='utf8')
if 'POST_NOTIFICATIONS' not in m:
    m = m.replace('</manifest>', '    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n</manifest>', 1)
if 'default_notification_channel_id' not in m:
    m = m.replace('</application>', '    <meta-data android:name="com.google.firebase.messaging.default_notification_channel_id" android:value="default" />\n    </application>', 1)
man.write_text(m, encoding='utf8')
# 8) الكاميرا: التقاط صورة الإيصال من حقل <input type=file capture> داخل WebView
if 'android.permission.CAMERA' not in m:
    m = m.replace('</manifest>', '    <uses-permission android:name="android.permission.CAMERA" />\n    <uses-feature android:name="android.hardware.camera" android:required="false" />\n</manifest>', 1)
man.write_text(m, encoding='utf8')
print('AndroidManifest: POST_NOTIFICATIONS + default channel + CAMERA')

print('patch-android: OK')
