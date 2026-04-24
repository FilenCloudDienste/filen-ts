#!/bin/sh

# Skip patch-package in CI environments (EAS Build, GitHub Actions, etc.). Needs to be run directly in the CI yaml.
if [ -n "$CI" ] || [ -n "$EAS_BUILD" ]; then
	exit 0
fi

npx -y patch-package  --patch-dir ./patches
