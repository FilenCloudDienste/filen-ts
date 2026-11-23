#!/usr/bin/env bash
# Runs `node scripts/ci/e2e.ts <args>` in the desktop session a deep chain needs.
#
# Linux: core dumps kept where the chain reads them (scripts/ci/e2e/linux.ts CORE_DIR), and one D-Bus session whose
# gnome-keyring holds an unlocked login keyring as its default collection, so every launch of the chain, the updater's
# relaunch included, keeps the session in the same secret service, as on a GNOME desktop. The daemon gets data and
# runtime directories of its own, as chain K's does (scripts/ci/e2e/linux.ts secretService): in the user's, a daemon of
# the user's systemd session (the gnome-keyring package enables its socket) can share the keyring files and control
# socket, and the login keyring then reads as locked, so a store wants an unlock prompt, which cannot show here. The
# keyring is checked before the chain starts (it exists, is unlocked and the default, and a store and lookup need no
# prompt); the daemon's output goes to keyring-daemon.log among the artifacts.
# Windows: the runner's own desktop session as it is (DPAPI needs no store; the chain registers WER LocalDumps itself).
# The harness writes to a file among the artifacts, which the step's log follows, so no process it starts holds the
# step's output pipe (a holder keeps the step open after the harness exits). E2E_STEP_DEADLINE_MINUTES (below the
# step's timeout, past the chain's budget and its watchdog's bounds): a harness still running then gets the machine's
# process table, volumes and screen written beside its log, then its tree is ended, so the step ends and the
# workflow's evidence upload runs.
set -euo pipefail

# The chain's --artifacts directory and scenario.
artifacts=e2e-artifacts
scenario=chain
previous=""

for arg in "$@"; do
	if [ "${previous}" = "--artifacts" ]; then
		artifacts="${arg}"
	elif [ "${previous}" = "--scenario" ]; then
		scenario="${arg}"
	fi

	previous="${arg}"
done

mkdir -p "${artifacts}"

case "$(uname -s)" in
	MINGW* | MSYS* | CYGWIN*)
		log="${artifacts}/${scenario}-harness.log"
		evidence="${artifacts}/${scenario}-deadline"
		: > "${log}"
		node scripts/ci/e2e.ts "$@" > "${log}" 2>&1 &
		harness=$!
		harness_win="$(cat "/proc/${harness}/winpid")"
		tail -f "${log}" &
		follower=$!

		deadline_s=$((${E2E_STEP_DEADLINE_MINUTES:-0} * 60))
		watcher=""

		if [ "${deadline_s}" -gt 0 ]; then
			(
				waited=0

				while [ "${waited}" -lt "${deadline_s}" ]; do
					sleep 5
					waited=$((waited + 5))
					kill -0 "${harness}" 2> /dev/null || exit 0
				done

				echo "::error::deep session: the harness (pid ${harness_win}) still runs ${E2E_STEP_DEADLINE_MINUTES} minutes in; evidence in ${evidence}-*, then its tree is ended"
				timeout 120 powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
					-File "$(cygpath -w scripts/ci/e2e/deadlineEvidence.ps1)" -Prefix "$(cygpath -w "${evidence}")" ||
					echo "::warning::deep session: the deadline evidence did not finish"
				taskkill //T //F //PID "${harness_win}" || echo "::warning::deep session: taskkill of ${harness_win} failed"
			) &
			watcher=$!
		fi

		status=0
		wait "${harness}" || status=$?
		sleep 1
		kill "${follower}" ${watcher:+"${watcher}"} 2> /dev/null || true
		exit "${status}"
		;;
	Linux) ;;
	*) exec node scripts/ci/e2e.ts "$@" ;;
esac

sudo install -d -m 1777 /tmp/filen-e2e-cores
sudo sysctl -w kernel.core_pattern=/tmp/filen-e2e-cores/core.%p.%e.%s
ulimit -c unlimited || ulimit -c "$(ulimit -H -c)"

KEYRING_LOG="$(realpath "${artifacts}")/keyring-daemon.log"
KEYRING_HOME="$(mktemp -d "${RUNNER_TEMP:-/tmp}/filen-e2e-keyring.XXXXXX")"
KEYRING_PASSWORD="$(openssl rand -hex 16)"
export KEYRING_LOG KEYRING_HOME KEYRING_PASSWORD

# shellcheck disable=SC2016
exec dbus-run-session -- bash -ec '
	login=/org/freedesktop/secrets/collection/login

	fail() {
		echo "::error::deep session keyring: $*" >&2
		cat "${KEYRING_LOG}" >&2 || true
		exit 1
	}

	secrets() {
		timeout 30 dbus-send --session --print-reply --dest=org.freedesktop.secrets "$@"
	}

	mkdir -p -m 700 "${KEYRING_HOME}/data" "${KEYRING_HOME}/run"
	printf %s "${KEYRING_PASSWORD}" |
		XDG_DATA_HOME="${KEYRING_HOME}/data" XDG_RUNTIME_DIR="${KEYRING_HOME}/run" \
			gnome-keyring-daemon --foreground --unlock --components=secrets >> "${KEYRING_LOG}" 2>&1 &
	unset KEYRING_PASSWORD

	owned=""

	for _ in $(seq 100); do
		if timeout 5 dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus \
			org.freedesktop.DBus.NameHasOwner string:org.freedesktop.secrets 2> /dev/null | grep -q "boolean true"; then
			owned=1
			break
		fi

		sleep 0.3
	done

	[ -n "${owned}" ] || fail "gnome-keyring never owned org.freedesktop.secrets"

	# The login keyring is created, unlocked, once the daemon has read the password.
	locked=""

	for _ in $(seq 100); do
		locked="$(secrets "${login}" org.freedesktop.DBus.Properties.Get string:org.freedesktop.Secret.Collection string:Locked 2> /dev/null || true)"
		[ -z "${locked}" ] || break
		sleep 0.3
	done

	case "${locked}" in
		*"boolean false"*) ;;
		"") fail "there is no login collection" ;;
		*) fail "the login collection is locked" ;;
	esac

	# libsecret stores into the default collection: without that alias, a store asks to create a keyring (a prompt).
	if ! secrets /org/freedesktop/secrets org.freedesktop.Secret.Service.ReadAlias string:default | grep -qF "\"${login}\""; then
		secrets /org/freedesktop/secrets org.freedesktop.Secret.Service.SetAlias string:default "objpath:${login}" > /dev/null ||
			fail "the login collection could not be made the default"
		secrets /org/freedesktop/secrets org.freedesktop.Secret.Service.ReadAlias string:default | grep -qF "\"${login}\"" ||
			fail "the default collection is not the login collection"
	fi

	probe="$(openssl rand -hex 16)"
	printf %s "${probe}" | timeout 30 secret-tool store --label="Filen e2e keyring probe" filen-e2e keyring-probe ||
		fail "secret-tool store failed (did it want a prompt?)"
	[ "$(timeout 30 secret-tool lookup filen-e2e keyring-probe)" = "${probe}" ] ||
		fail "secret-tool lookup did not return what was stored"
	timeout 30 secret-tool clear filen-e2e keyring-probe || fail "secret-tool clear failed"
	echo "deep session keyring: the login collection is unlocked and the default; a store and lookup needed no prompt"

	export XDG_CURRENT_DESKTOP=GNOME
	exec node scripts/ci/e2e.ts "$@"
' e2e "$@"
