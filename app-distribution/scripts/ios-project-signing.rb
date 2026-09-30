#!/usr/bin/env ruby
# frozen_string_literal: true

# Per-target manual signing for the CI checkout (the same idea as fastlane's update_code_signing_settings).
#
#   ios-project-signing.rb list  <Runner.xcodeproj> <scheme>
#       prints JSON [{"target","productType","bundleId"}] for every app / app-extension target that the scheme's
#       archive configuration builds, so the workflow can fetch one ad-hoc profile per bundle ID (extensions included).
#   ios-project-signing.rb apply <Runner.xcodeproj> <scheme> <team-id> <profiles.json>
#       profiles.json maps bundle ID => profile name. Each matching target gets CODE_SIGN_STYLE=Manual, the
#       Apple Distribution identity, its own PROVISIONING_PROFILE_SPECIFIER and DEVELOPMENT_TEAM.
#
# Why not xcodebuild command-line overrides: PROVISIONING_PROFILE_SPECIFIER on the command line applies to EVERY target
# (Pods frameworks and bundles reject it: "does not support provisioning profiles"). Editing only the app/extension
# targets keeps Pods untouched. It edits the ephemeral CI checkout only, never a committed file.
# Fails closed: a target whose bundle ID is unknown or has no profile stops the build; it never falls back to automatic.
require 'json'

begin
  require 'xcodeproj'
rescue LoadError
  # Homebrew's CocoaPods keeps its gems private; install the same gem for this user instead.
  system('gem', 'install', 'xcodeproj', '--user-install', '--no-document', out: $stderr) || abort('xcodeproj gem を用意できません')
  Gem.clear_paths
  require 'xcodeproj'
end

SIGNED_TYPES = %w[com.apple.product-type.application com.apple.product-type.app-extension].freeze
IDENTITY = 'Apple Distribution'

def xcconfig_values(path, seen = {})
  return {} unless path && File.file?(path) && !seen[path]

  seen[path] = true
  values = {}
  File.readlines(path).each do |line|
    line = line.sub(%r{//.*}, '').strip
    if (m = line.match(/\A#include\??\s+"(.+)"\z/))
      values.merge!(xcconfig_values(File.expand_path(m[1], File.dirname(path)), seen))
    elsif (m = line.match(/\A([A-Za-z0-9_]+)(?:\[[^\]]*\])*\s*=\s*(.*)\z/))
      values[m[1]] = m[2]
    end
  end
  values
end

def settings_for(project, target, config_name)
  target_config = target.build_configurations.find { |c| c.name == config_name }
  return nil unless target_config

  project_config = project.build_configurations.find { |c| c.name == config_name }
  base = ->(c) { c&.base_configuration_reference&.real_path&.to_s }
  {}.merge(xcconfig_values(base.call(project_config)))
    .merge(project_config&.build_settings || {})
    .merge(xcconfig_values(base.call(target_config)))
    .merge(target_config.build_settings)
end

def resolve(value, settings, depth = 0)
  return value unless value.is_a?(String)
  return value if depth > 8

  value.gsub(/\$[({]([A-Za-z0-9_]+)(?::[^)}]*)?[)}]/) do
    name = Regexp.last_match(1)
    settings.key?(name) ? resolve(settings[name].to_s, settings, depth + 1) : Regexp.last_match(0)
  end
end

def archive_configuration(project_path, scheme_name)
  path = File.join(project_path, 'xcshareddata', 'xcschemes', "#{scheme_name}.xcscheme")
  return 'Release' unless File.file?(path)

  Xcodeproj::XCScheme.new(path).archive_action.build_configuration || 'Release'
end

def signed_targets(project, config_name)
  project.native_targets.select { |t| SIGNED_TYPES.include?(t.product_type) }.map do |target|
    settings = settings_for(project, target, config_name)
    raise "ターゲット #{target.name} にビルド構成 #{config_name} がありません" unless settings

    bundle_id = resolve(settings['PRODUCT_BUNDLE_IDENTIFIER'].to_s, settings)
    raise "ターゲット #{target.name} の Bundle ID を解決できません（#{bundle_id}）" if bundle_id.empty? || bundle_id.include?('$')

    { target: target, bundle_id: bundle_id }
  end
end

mode, project_path, scheme, team, profiles_file = ARGV
abort('usage: ios-project-signing.rb list <xcodeproj> <scheme> | apply <xcodeproj> <scheme> <team> <profiles.json>') unless %w[list apply].include?(mode) && project_path && scheme

project = Xcodeproj::Project.open(project_path)
config_name = archive_configuration(project_path, scheme)
targets = signed_targets(project, config_name)
abort('署名対象のターゲットがありません') if targets.empty?

if mode == 'list'
  puts JSON.generate(targets.map { |t| { target: t[:target].name, productType: t[:target].product_type, bundleId: t[:bundle_id], configuration: config_name } })
else
  abort('Team ID が不正です') unless team.to_s.match?(/\A[A-Z0-9]{10}\z/)
  profiles = JSON.parse(File.read(profiles_file))
  targets.each do |entry|
    name = profiles[entry[:bundle_id]]
    abort("#{entry[:bundle_id]} のプロファイルがありません") if name.to_s.empty?

    config = entry[:target].build_configurations.find { |c| c.name == config_name }
    settings = config.build_settings
    settings['CODE_SIGN_STYLE'] = 'Manual'
    settings['DEVELOPMENT_TEAM'] = team
    settings['CODE_SIGN_IDENTITY'] = IDENTITY
    settings['PROVISIONING_PROFILE_SPECIFIER'] = name
    %w[PROVISIONING_PROFILE CODE_SIGN_IDENTITY[sdk=iphoneos*] PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]].each { |key| settings.delete(key) }
    warn "署名: #{entry[:target].name} (#{entry[:bundle_id]}) -> #{name}"
  end
  project.save
end
