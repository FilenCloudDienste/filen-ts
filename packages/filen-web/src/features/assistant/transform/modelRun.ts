import { AssistantAbortError, type AssistantModel } from "@filen/shared/assistant"
import type { AssistantRuntimeLike } from "@/features/assistant/loop/session"
import { onAbort, raceAbort } from "@/lib/abort"
import { log } from "@/lib/log"

// What the one-generation helpers (the selection transform, the formula helper, speaker notes, form fill) share: the
// extraction slot, so the conversation's cached prompt in the main slot stays as it was; the model held for the
// generation and loaded first when it is only on disk; one request at a time per helper (a new one stops the one
// before; the worker runs one generation at a time anyway, so helpers and a turn queue rather than interleave);
// nothing after signing out.

export type ModelRuntime = Pick<AssistantRuntimeLike, "model" | "getState" | "load" | "hold">

// "model-unavailable": the model could not be loaded (the model state says why). "cancelled": the request's signal, a
// newer request or signing out stopped it. "failed": the generation threw.
export interface ModelRunFailure {
	ok: false
	error: "model-unavailable" | "cancelled" | "failed"
}

export interface ModelRunner {
	// Runs `work` on the loaded model with a signal that also stops for a newer request and for signing out. `label`
	// names the helper in the log line of a failure.
	run: <T>(
		signal: AbortSignal,
		label: string,
		work: (model: AssistantModel, signal: AbortSignal) => Promise<T>
	) => Promise<T | ModelRunFailure>
	// Signing out: stops the one running and refuses anything further.
	shutdown: () => void
}

export function createModelRunner(runtime: ModelRuntime): ModelRunner {
	let active: AbortController | null = null
	let shutDown = false

	async function run<T>(
		signal: AbortSignal,
		label: string,
		work: (model: AssistantModel, signal: AbortSignal) => Promise<T>
	): Promise<T | ModelRunFailure> {
		active?.abort()

		const controller = new AbortController()
		const unsubscribe = onAbort(signal, () => {
			controller.abort()
		})

		active = controller

		if (shutDown) {
			controller.abort()
		}

		// Held from the start: a load must not be followed by the idle unload before the generation begins.
		const release = runtime.hold()

		try {
			if (runtime.getState().kind !== "ready") {
				await raceAbort(runtime.load(), controller.signal)
			}

			if (controller.signal.aborted) {
				return { ok: false, error: "cancelled" }
			}

			if (runtime.getState().kind !== "ready") {
				return { ok: false, error: "model-unavailable" }
			}

			return await work(runtime.model, controller.signal)
		} catch (e) {
			if (controller.signal.aborted || e instanceof AssistantAbortError) {
				return { ok: false, error: "cancelled" }
			}

			log.error("assistant", `${label} failed`, e)

			return { ok: false, error: runtime.getState().kind === "ready" ? "failed" : "model-unavailable" }
		} finally {
			unsubscribe()
			release()

			if (active === controller) {
				active = null
			}
		}
	}

	return {
		run,
		shutdown: () => {
			shutDown = true
			active?.abort()
		}
	}
}

// A generation's prompt progress as the share read (0..1).
export function progressShare(onProgress: ((share: number) => void) | undefined): (progress: { processed: number; total: number }) => void {
	return ({ processed, total }) => {
		onProgress?.(total > 0 ? Math.min(1, processed / total) : 0)
	}
}
