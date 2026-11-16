import { log } from "@/lib/log"

// Resources a preview holds that must not outlive the session (served ports, engines, workers): each registers how to
// drop itself, and sign-out runs them all.

interface Disposer {
	readonly label: string
	readonly dispose: () => void
}

const disposers = new Set<Disposer>()

// Returns the unregister function. A disposer runs at most once: running it unregisters it.
export function registerPreviewDisposer(label: string, dispose: () => void): () => void {
	const entry: Disposer = { label, dispose }

	disposers.add(entry)

	return () => {
		disposers.delete(entry)
	}
}

// Runs every registered disposer (sign-out). A failing one is logged under its label and never stops the others.
export function runPreviewDisposers(): void {
	const pending = [...disposers]

	disposers.clear()

	for (const { label, dispose } of pending) {
		try {
			dispose()
		} catch (e) {
			log.warn("previewDisposers", `disposer "${label}" failed`, e)
		}
	}
}
