// A worker the page creates after boot is its own file, and a deploy that changed it removes the old
// one, so a tab opened before the deploy fails to start it. Once a newer build is known to be deployed,
// this decides what the tab does about it.
export type StaleBuildAction = "reload" | "prompt" | "none"

// A second failure this soon after reloading means the new build fails too; looping would hide it.
export const STALE_RELOAD_COOLDOWN_MS = 60_000

export function staleBuildAction(input: { busy: boolean; lastReloadAt: number | null; now: number }): StaleBuildAction {
	// Running transfers or unsaved edits would be dropped by a reload, so the user decides when.
	if (input.busy) {
		return "prompt"
	}

	if (input.lastReloadAt !== null && input.now - input.lastReloadAt < STALE_RELOAD_COOLDOWN_MS) {
		return "none"
	}

	return "reload"
}

// Whether the deployed index.html still loads the bundle this tab runs. The page is one bundle, so a
// deploy that changed anything references a different file.
export function isBuildStillDeployed(indexHtml: string, runningBundlePath: string): boolean {
	return indexHtml.includes(runningBundlePath)
}
