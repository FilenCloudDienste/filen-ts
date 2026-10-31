import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import type { Target } from "../targets.ts"

// The e2e scripts install, reset and uninstall the real app: Target.reset() deletes Filen's whole userData, caches and
// install. They run on GitHub's throwaway runners only, or on a machine its owner explicitly marks as disposable, and
// even then never over an existing Filen.

export const DISPOSABLE_ENV = "FILEN_E2E_DISPOSABLE_MACHINE"
export const DISPOSABLE_VALUE = "destroy-filen-data"

export interface MachineState {
	githubActions: boolean
	disposable: boolean
	// What a real installation leaves, by path or description.
	existing: string[]
}

export function refusal({ githubActions, disposable, existing }: MachineState): string | null {
	if (githubActions) {
		return null
	}

	if (!disposable) {
		return `refusing to run outside GitHub Actions: these scripts delete Filen's app and data. On a disposable machine set ${DISPOSABLE_ENV}=${DISPOSABLE_VALUE}.`
	}

	if (existing.length > 0) {
		return `refusing to run: this machine has Filen data (${existing.join(", ")}). Disposable means a machine without it.`
	}

	return null
}

let checked = false

// Once per process, before the first target exists (so before any reset or install).
export function assertDisposableMachine(target: Target): void {
	if (checked) {
		return
	}

	const githubActions = process.env["GITHUB_ACTIONS"] === "true"
	const disposable = process.env[DISPOSABLE_ENV] === DISPOSABLE_VALUE
	const existing = githubActions
		? []
		: [path.dirname(target.userData), target.executable].filter(entry => existsSync(entry)).concat(macSafeStorage())
	const reason = refusal({ githubActions, disposable, existing })

	if (reason !== null) {
		console.error(`::error::${reason}`)
		process.exit(2)
	}

	checked = true
}

// The keychain item Chromium's safeStorage creates for "Filen" (3.x and 4.x share the name).
function macSafeStorage(): string[] {
	if (process.platform !== "darwin") {
		return []
	}

	const found = spawnSync("security", ["find-generic-password", "-s", "Filen Safe Storage"], { stdio: "ignore" })

	return found.status === 0 ? ['keychain item "Filen Safe Storage"'] : []
}
