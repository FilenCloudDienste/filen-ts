#!/usr/bin/env bash
# Runs `node scripts/ci/e2e.ts <args>` in the desktop session a deep chain needs.
#
# Linux: core dumps kept where the chain reads them (scripts/ci/e2e/linux.ts CORE_DIR), and one D-Bus session whose
# gnome-keyring is unlocked (created on first use), so every launch of the chain, the updater's relaunch included,
# keeps the session in the same secret service, as on a GNOME desktop.
# Windows: the runner's own desktop session as it is (DPAPI needs no store; the chain registers WER LocalDumps itself).
set -euo pipefail

if [ "$(uname -s)" != "Linux" ]; then
	exec node scripts/ci/e2e.ts "$@"
fi

sudo install -d -m 1777 /tmp/filen-e2e-cores
sudo sysctl -w kernel.core_pattern=/tmp/filen-e2e-cores/core.%p.%e.%s
ulimit -c unlimited || ulimit -c "$(ulimit -H -c)"

KEYRING_PASSWORD="$(openssl rand -hex 16)"
export KEYRING_PASSWORD

# shellcheck disable=SC2016
exec dbus-run-session -- bash -ec '
	printf %s "${KEYRING_PASSWORD}" | gnome-keyring-daemon --daemonize --unlock --components=secrets > /dev/null
	unset KEYRING_PASSWORD
	export XDG_CURRENT_DESKTOP=GNOME
	exec node scripts/ci/e2e.ts "$@"
' e2e "$@"
