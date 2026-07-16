Pod::Spec.new do |s|
  s.name           = 'FilenExif'
  s.version        = '0.1.0'
  s.summary        = 'Native EXIF/XMP metadata transplant (lossless, no re-encode)'
  s.description    = 'Copies image metadata into a re-encoded JPEG via CGImageDestinationCopyImageSource without decoding pixels.'
  s.author         = 'Filen'
  s.homepage       = 'https://filen.io'
  s.platforms      = { :ios => '15.1', :tvos => '15.1' }
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
