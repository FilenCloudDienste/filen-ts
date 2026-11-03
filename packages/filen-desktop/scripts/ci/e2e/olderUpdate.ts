import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { LegacyPin } from "../legacy.ts"
import { fail, runBounded } from "../support.ts"
import { detached, linuxProcesses, type AppProcess, type Target } from "../targets.ts"

// What an old release older than the fleet's last one needs around its install and update (scripts/ci/legacy.ts
// OLDER_PIN): its own Linux executable name, a root prompt its updater can use, and after the update the proof that
// 4.x's @filendesktop link brought it back. Node built-ins only: the update scenario at install depth runs it.

const DELETED = " (deleted)"
const TOOL_TIMEOUT_MS = 15_000

function linuxPackaged(target: Target): boolean {
	return target.platform === "linux" && (target.format === "deb" || target.format === "rpm")
}

// The target as the old release installs it: on Linux deb and rpm its executable has its own name, which its main
// process runs as (and, once dpkg replaced it, as "<name> (deleted)"), and the install has neither 4.x's executable
// nor its package-type and AppArmor files to check. Every other target is the same as 4.x's.
export function installedBy(target: Target, pin: LegacyPin): Target {
	const executable = pin.linuxExecutable

	if (!linuxPackaged(target) || executable === target.executable) {
		return target
	}

	const mainProcesses = (): AppProcess[] =>
		linuxProcesses((_pid, exe) => (exe === executable || exe === `${executable}${DELETED}` ? exe : null))

	return {
		...target,
		executable,
		launch: (env, args = [], output) => detached(executable, args, env, output),
		launchEnv: env => env,
		mainProcesses,
		reset() {
			for (const { pid } of mainProcesses()) {
				try {
					process.kill(pid, "SIGKILL")
				} catch {
					// Already gone.
				}
			}

			target.reset()
		},
		verifyInstall() {
			if (!existsSync(executable)) {
				fail(`${executable} is missing: ${pin.version} put its executable somewhere else`)
			}

			if (target.registeredVersion() === null) {
				fail("the package manager does not list Filen as installed")
			}
		}
	}
}

// electron-updater 6.5.0 on Linux asks for root through gksudo, kdesudo, pkexec or beesu and has no sudo fallback, and
// none of them can prompt on a runner (the workflow hides them). This pkexec, put first on the old app's PATH only,
// drops the polkit-only flag its updater adds and runs the rest through the runner's passwordless sudo; the harness
// and N keep the PATH without it. Returns the directory to prepend.
export function promptShim(dir: string): string {
	mkdirSync(dir, { recursive: true })

	const file = path.join(dir, "pkexec")

	writeFileSync(file, '#!/bin/sh\nif [ "$1" = "--disable-internal-agent" ]; then shift; fi\nexec sudo -n "$@"\n')
	chmodSync(file, 0o755)

	return dir
}

// The old app's environment for its update launch: `env`, with the prompt shim first on PATH where its updater needs
// one (Linux deb and rpm, not as root).
export function updateEnvFor(target: Target, pin: LegacyPin, env: NodeJS.ProcessEnv, work: string): NodeJS.ProcessEnv {
	if (!pin.linuxNeedsPrompt || !linuxPackaged(target) || process.getuid?.() === 0) {
		return env
	}

	const shim = promptShim(path.join(work, "prompt-shim"))

	return { ...env, PATH: [shim, env["PATH"] ?? ""].filter(item => item !== "").join(path.delimiter) }
}

// The first argument of a process's command line (what it was started as), null when unreadable.
export function argv0(pid: number): string | null {
	try {
		return readFileSync(`/proc/${String(pid)}/cmdline`, "utf8").split("\0")[0] ?? null
	} catch {
		return null
	}
}

// What the links that may name the old executable resolve to: the old path itself, and the update-alternatives entry
// its deb's postinst made (/usr/bin/<name> -> /etc/alternatives/<name> -> the old path). Its postrm removes that entry
// with the link path instead of the alternative, which does nothing, so the entry outlives the old package. Each
// present link must resolve to `executable`; a missing one is not a problem. `root` prefixes every path (tests).
export function legacyLinkProblems(oldExecutable: string, executable: string, root = ""): { problems: string[]; seen: string[] } {
	const name = path.basename(oldExecutable)
	const want = realpathSync(path.join(root, executable))
	const problems: string[] = []
	const seen: string[] = []

	for (const link of [oldExecutable, `/usr/bin/${name}`, `/etc/alternatives/${name}`]) {
		const file = path.join(root, link)

		if (lstatSync(file, { throwIfNoEntry: false }) === undefined) {
			if (link === oldExecutable) {
				problems.push(`${link} is missing`)
			}

			continue
		}

		let resolved: string | null

		try {
			resolved = realpathSync(file)
		} catch {
			resolved = null
		}

		seen.push(`${link} -> ${resolved ?? "nothing"}`)

		if (resolved !== want) {
			problems.push(resolved === null ? `${link} dangles` : `${link} resolves to ${resolved}, not ${executable}`)
		}
	}

	return { problems, seen }
}

// B4 after the update from a release whose Linux executable had another name: N came back through the old path (its
// updater relaunches the argv it was started with), that path is 4.x's link to its executable, and no alternative the
// old package registered dangles.
export async function verifyLegacyLink(target: Target, pin: LegacyPin, relaunched: readonly number[]): Promise<string> {
	if (!linuxPackaged(target) || pin.linuxExecutable === target.executable) {
		return "nothing to check: the old release's executable has N's name here"
	}

	const started = relaunched.map(pid => argv0(pid))

	if (!started.includes(pin.linuxExecutable)) {
		fail(`N's main process was started as ${started.join(", ") || "nothing readable"}, not through ${pin.linuxExecutable}`)
	}

	const { problems, seen } = legacyLinkProblems(pin.linuxExecutable, target.executable)
	const query = await runBounded("update-alternatives", ["--query", path.basename(pin.linuxExecutable)], TOOL_TIMEOUT_MS)

	console.log(`update-alternatives --query: ${(query.stdout || query.stderr).trim().replace(/\n/g, "; ") || "(nothing)"}`)

	if (problems.length > 0) {
		fail(problems.join("; "))
	}

	return `relaunched through ${pin.linuxExecutable}; ${seen.join(", ")}`
}
