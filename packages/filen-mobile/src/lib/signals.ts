import { ManagedAbortController, type ManagedAbortSignal, PauseSignal as SdkPauseSignal } from "@filen/sdk-rs"

export const toSignalOpts = (signal?: AbortSignal): { signal: AbortSignal } | undefined => (signal ? { signal } : undefined)

// wrapAbortSignalForSdk allocates TWO uniffi (Rust Arc-backed) handles per call — a
// ManagedAbortController AND its .signal() — and the RN bindings have NO FinalizationRegistry, so BOTH
// must be freed explicitly once the SDK call settles or they leak (TC-01). The controller and the
// source-signal abort listener are tracked here, keyed by the returned signal, so callers free
// everything via disposeSdkAbortSignal(signal) instead of signal.uniffiDestroy() (which frees only the
// signal and leaks the controller).
const wrappedAbortSignalRegistry = new WeakMap<
	ManagedAbortSignal,
	{
		controller: ManagedAbortController
		source: AbortSignal
		onAbort: () => void
	}
>()

export function wrapAbortSignalForSdk(abortSignal: AbortSignal): ManagedAbortSignal {
	const abortController = new ManagedAbortController()
	const onAbort = () => {
		abortController.abort()
	}

	abortSignal.addEventListener("abort", onAbort, {
		once: true
	})

	// Need to cast because of a bug in uniffi generated types
	const signal = abortController.signal() as ManagedAbortSignal

	wrappedAbortSignalRegistry.set(signal, {
		controller: abortController,
		source: abortSignal,
		onAbort
	})

	return signal
}

// Free a signal returned by wrapAbortSignalForSdk together with its backing ManagedAbortController and
// the source abort listener. Call this — NOT signal.uniffiDestroy() — once the SDK call has settled;
// otherwise the controller handle leaks (no GC for uniffi handles). Safe with undefined (callers pass
// `signal ? wrapAbortSignalForSdk(signal) : undefined`).
export function disposeSdkAbortSignal(signal: ManagedAbortSignal | null | undefined): void {
	if (!signal) {
		return
	}

	const entry = wrappedAbortSignalRegistry.get(signal)

	if (!entry) {
		// Not (or no longer) registry-tracked: at most free the signal handle; never risk a double-free
		// of an untracked controller.
		signal.uniffiDestroy()

		return
	}

	// Remove the abort listener BEFORE destroying the controller so a late source-signal abort can
	// never call controller.abort() on a freed handle (clonePointer on a destroyed object throws).
	entry.source.removeEventListener("abort", entry.onAbort)
	wrappedAbortSignalRegistry.delete(signal)

	signal.uniffiDestroy()
	entry.controller.uniffiDestroy()
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
	// Set once dispose() frees the underlying Rust Arc handle. After that, pause()/resume()/isPaused()
	// must not touch the freed handle: a stale UI tap (e.g. Pause/Resume on a settled transfer whose
	// store entry still lingers) would otherwise throw UnexpectedNullPointer synchronously and crash the app.
	private disposed: boolean = false

	public pause(): void {
		if (this.disposed || this.isPaused()) {
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
		if (this.disposed || !this.isPaused()) {
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
		return this.disposed ? false : this.signal.isPaused()
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
		if (this.disposed) {
			return
		}

		this.disposed = true

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
