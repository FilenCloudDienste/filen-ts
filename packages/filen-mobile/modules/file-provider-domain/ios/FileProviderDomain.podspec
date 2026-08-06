Pod::Spec.new do |s|
  s.name           = 'FileProviderDomain'
  s.version        = '0.1.0'
  s.summary        = 'Registers the Filen NSFileProviderDomain with the system'
  s.description    = 'Thin wrapper over NSFileProviderManager.add / .remove / .domains for the replicated file provider extension.'
  s.author         = 'Filen'
  s.homepage       = 'https://filen.io'
  # 16.0, not the 15.1 the other local modules use: NSFileProviderDomain(identifier:displayName:) is
  # iOS 16+. The app's own IOS_DEPLOYMENT_TARGET (app.config.ts) is higher still, so this floor only
  # documents the API requirement — do not lower it.
  s.platforms      = { :ios => '16.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
