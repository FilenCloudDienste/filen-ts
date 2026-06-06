import { ManagedAbortController, type ManagedAbortSignal, PauseSignal as SdkPauseSignal } from "@filen/sdk-rs"

export const toSignalOpts = (signal?: AbortSignal): { signal: AbortSignal } | undefined => (signal ? { signal } : undefined)

export function wrapAbortSignalForSdk(abortSignal: AbortSignal) {
	const abortController = new ManagedAbortController()

	abortSignal.addEventListener(
		"abort",
		() => {
			abortController.abort()
		},
		{
			once: true
		}
	)

	// Need to cast because of a bug in uniffi generated types
	return abortController.signal() as ManagedAbortSignal
}

export function createCompositeAbortSignal(...signals: AbortSignal[]): AbortSignal & {
	dispose: () => void
} {
	const controller = new AbortController()
	const subscriptions: {
		remove: () => void
	}[] = []

	for (const signal of signals) {
		if (signal.aborted) {
			controller.abort()

			for (const sub of subscriptions) {
				sub.remove()
			}

			return Object.assign(controller.signal, {
				dispose: () => {}
			})
		}

		const handler = () => controller.abort()

		signal.addEventListener("abort", handler, {
			once: true
		})

		subscriptions.push({
			remove: () => signal.removeEventListener("abort", handler)
		})
	}

	return Object.assign(controller.signal, {
		dispose: () => {
			for (const sub of subscriptions) {
				sub.remove()
			}

			subscriptions.length = 0
		}
	})
}

export class PauseSignal {
	private readonly signal: SdkPauseSignal = new SdkPauseSignal()
	private readonly pauseListeners: Set<() => void> = new Set()
	private readonly resumeListeners: Set<() => void> = new Set()

	public pause(): void {
		if (this.isPaused()) {
			return
		}

		this.signal.pause()

		for (const listener of this.pauseListeners) {
			try {
				listener()
			} catch {
				// Noop
			}
		}
	}

	public resume(): void {
		if (!this.isPaused()) {
			return
		}

		this.signal.resume()

		for (const listener of this.resumeListeners) {
			try {
				listener()
			} catch {
				// Noop
			}
		}
	}

	public isPaused(): boolean {
		return this.signal.isPaused()
	}

	public getSignal(): SdkPauseSignal {
		return this.signal
	}

	public addEventListener<T extends "pause" | "resume">(
		event: T,
		callback: () => void
	): {
		remove: () => void
	} {
		if (event === "resume") {
			this.resumeListeners.add(callback)

			return {
				remove: () => {
					this.resumeListeners.delete(callback)
				}
			}
		}

		this.pauseListeners.add(callback)

		return {
			remove: () => {
				this.pauseListeners.delete(callback)
			}
		}
	}

	public removeAllListeners(): void {
		this.pauseListeners.clear()
		this.resumeListeners.clear()
	}

	public removeEventListener<T extends "pause" | "resume">(event: T, callback: () => void): void {
		if (event === "resume") {
			this.resumeListeners.delete(callback)
		} else {
			this.pauseListeners.delete(callback)
		}
	}

	// The underlying SdkPauseSignal is a uniffi (Rust Arc-backed) handle that must be released explicitly.
	// Callers that own a PauseSignal must call dispose() once it is no longer needed.
	public dispose(): void {
		this.removeAllListeners()

		this.signal.uniffiDestroy()
	}
}

export function createCompositePauseSignal(...signals: PauseSignal[]): PauseSignal & {
	dispose: () => void
} {
	const controller = new PauseSignal()
	const subscriptions: {
		remove: () => void
	}[] = []

	for (const signal of signals) {
		if (signal.isPaused()) {
			controller.pause()
		}

		subscriptions.push(signal.addEventListener("pause", () => controller.pause()))

		subscriptions.push(
			signal.addEventListener("resume", () => {
				if (signals.every(s => !s.isPaused())) {
					controller.resume()
				}
			})
		)
	}

	// Capture the prototype method before Object.assign shadows it with the augmented dispose below,
	// otherwise the augmented dispose would recurse into itself instead of freeing the SDK handle.
	const disposeController = PauseSignal.prototype.dispose.bind(controller)

	return Object.assign(controller, {
		dispose: () => {
			for (const sub of subscriptions) {
				sub.remove()
			}

			subscriptions.length = 0

			// Free the SdkPauseSignal allocated for the composite controller above.
			disposeController()
		}
	})
}
