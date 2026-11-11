// Marks what a download wrote as coming from the internet (macOS quarantine, Windows Mark of the Web) before the page
// can open it. Sync never goes through here.
export interface Quarantine {
	mark(paths: readonly string[]): Promise<void>
}

// Until the platform marking lands: marks nothing.
export const noQuarantine: Quarantine = {
	mark: () => Promise.resolve()
}
