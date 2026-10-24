# يعدّل مشروع Xcode الذي ولّده Capacitor أثناء البناء على GitHub Actions:
# التوقيع التلقائي + Sign in with Apple (Entitlements) + رقم الإصدار والبناء + iPhone وiPad.
require 'xcodeproj'

team    = ENV.fetch('TEAM_ID')
version = ENV.fetch('MARKETING_VERSION', '1.0')
build   = ENV.fetch('BUILD_NUMBER', '1')
bundle  = ENV.fetch('BUNDLE_ID', 'com.prom1406.sewaa')

proj = Xcodeproj::Project.open('ios/App/App.xcodeproj')
target = proj.targets.find { |t| t.name == 'App' } or abort('target App غير موجود')

target.build_configurations.each do |c|
  s = c.build_settings
  s['CODE_SIGN_STYLE']             = 'Automatic'
  s['DEVELOPMENT_TEAM']            = team
  s['CODE_SIGN_ENTITLEMENTS']      = 'App/App.entitlements'
  s['PRODUCT_BUNDLE_IDENTIFIER']   = bundle
  s['MARKETING_VERSION']           = version
  s['CURRENT_PROJECT_VERSION']     = build
  s['TARGETED_DEVICE_FAMILY']      = '1,2'
  ld = Array(s['OTHER_LDFLAGS']).join(' ').split
  s['OTHER_LDFLAGS'] = (['$(inherited)'] + ld + ['-ObjC']).uniq # يلزم Firebase Auth/reCAPTCHA
end
plist = 'ios/App/App/GoogleService-Info.plist'
if File.exist?(plist)
  grp = proj.main_group['App'] or abort('مجموعة App غير موجودة')
  unless grp.files.any? { |f| f.path == 'GoogleService-Info.plist' }
    ref = grp.new_reference('GoogleService-Info.plist')
    target.resources_build_phase.add_file_reference(ref)
  end
else
  abort('GoogleService-Info.plist غير موجود: التطبيق سينهار عند الفتح')
end
proj.save
puts "patched: team=#{team} bundle=#{bundle} version=#{version} (#{build})"
