// Coordinates "an in-app native presentation is on screen" across the privacy screen and the
// biometric lock, so neither reacts to the resign-active / background that such a presentation
// causes. The blur (expo-screen-capture) arms on willResignActive and the biometric AppState
// re-lock fires on a background→active transition — both of which an image/document picker, a
// permission dialog, or the Face ID prompt trigger even though the user never really left the app.
//
// Every such presentation is funnelled through withSystemPresentation(). While one is active we:
//   - lift the native privacy blur (the privacy host registers a suppressor that we call on the
//     0→1 and 1→0 transitions, so the blur is gone before the prompt resigns the app active), and
//   - tell the biometric re-lock to skip (via isReLockSuppressed(), which also covers a short grace
//     window after release so it survives the "AppState→active fires before the picker promise
//     resolves" race).

export const RELOCK_SUPPRESSION_GRACE_MS = 1500

// Pure predicate (exported for tests): is the biometric re-lock currently suppressed?
export function reLockSuppressed(
	activeCount: number,
	lastEndedAt: number,
	now: number,
	graceMs: number = RELOCK_SUPPRESSION_GRACE_MS
): boolean {
	return activeCount > 0 || now - lastEndedAt < graceMs
}

export type PresentationSuppressor = (suppressed: boolean) => Promise<void>

export class SystemPresentation {
	private activeCount: number = 0
	private lastEndedAt: number = 0
	private suppressor: PresentationSuppressor | null = null

	// The privacy host registers how to lift/restore the native blur. Called on the 0→1 and 1→0
	// transitions only. Returns an unregister fn for the host's effect cleanup.
	public registerSuppressor(suppressor: PresentationSuppressor): () => void {
		this.suppressor = suppressor

		return () => {
			if (this.suppressor === suppressor) {
				this.suppressor = null
			}
		}
	}

	// True while at least one presentation is on screen — used by the privacy host to keep the blur lifted.
	public isActive(): boolean {
		return this.activeCount > 0
	}

	// True while a presentation is active OR within the post-release grace window — used by the
	// biometric AppState listener to skip re-locking after returning from an in-app presentation.
	public isReLockSuppressed(now: number = Date.now()): boolean {
		return reLockSuppressed(this.activeCount, this.lastEndedAt, now)
	}

	public async begin(): Promise<void> {
		const wasInactive = this.activeCount === 0
		this.activeCount++

		if (wasInactive && this.suppressor) {
			await this.suppressor(true).catch(console.error)
		}
	}

	public async end(): Promise<void> {
		if (this.activeCount === 0) {
			return
		}

		this.activeCount--

		if (this.activeCount === 0) {
			this.lastEndedAt = Date.now()

			if (this.suppressor) {
				await this.suppressor(false).catch(console.error)
			}
		}
	}
}

export const systemPresentation = new SystemPresentation()

// Wrap any in-app native presentation (image/document picker, permission prompt, Face ID, document
// scanner, …) so the privacy blur and the biometric re-lock don't react to it. begin() awaits the
// blur being lifted BEFORE fn() runs, so the presentation can't flash the blur as it resigns active.
export async function withSystemPresentation<T>(fn: () => Promise<T>): Promise<T> {
	await systemPresentation.begin()

	try {
		return await fn()
	} finally {
		await systemPresentation.end()
	}
}

export default systemPresentation
