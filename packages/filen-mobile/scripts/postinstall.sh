#!/bin/sh

# Skip patch-package in CI environments (EAS Build, GitHub Actions, etc.). Needs to be run directly in the CI yaml.
if [ -n "$CI" ] || [ -n "$EAS_BUILD" ]; then
	exit 0
fi

# --error-on-fail: locally patch-package exits 0 even when a patch fails to apply, so a failure is a
# scrollback warning and the build silently uses upstream code. That is not acceptable for these
# patches — several carry security hardening (the @expo/dom-webview WebView lockdown), and the module
# it targets is a TRANSITIVE dep of `expo ~57.0.8`, so a routine patch-level Expo bump can change its
# version underneath us. Fail the install instead and fix the patch. (CI already behaves this way:
# patch-package auto-detects CI and defaults to exiting 1 there.)
npx -y patch-package --error-on-fail --patch-dir ./patches
