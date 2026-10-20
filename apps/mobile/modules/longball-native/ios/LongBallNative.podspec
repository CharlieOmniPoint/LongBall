require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name = 'LongBallNative'
  s.version = package['version']
  s.summary = package['description']
  s.description = package['description']
  s.license = { :type => 'UNLICENSED' }
  s.author = 'LongBall'
  s.homepage = 'https://github.com/CharlieOmniPoint/LongBall'
  s.source = { :git => 'https://github.com/CharlieOmniPoint/LongBall.git' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
end
