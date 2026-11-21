import { AssistantAbortError, transformFits, transformText, TransformTooLongError } from "@filen/shared/assistant"
import type { AssistantRuntimeLike } from "@/features/assistant/loop/session"
import type { AssistantTransformer, AssistantTransformOutcome, AssistantTransformRequest } from "@/features/assistant/types"
import { onAbort, raceAbort } from "@/lib/abort"
import { log } from "@/lib/log"

// The selection transform over the on-device model (@filen/shared/assistant transformText): the extraction slot,
// so the conversation's cached prompt in the main slot stays as it was; the worker runs one generation at a time,
// so a transform and a turn queue rather than interleave. The model is held for the generation and loaded first
// when it is only on disk.
export function createAssistantTransformer(
	runtime: Pick<AssistantRuntimeLike, "model" | "getState" | "load" | "hold">
): AssistantTransformer {
	let active: AbortController | null = null
	let shutDown = false

	async function run(request: AssistantTransformRequest): Promise<AssistantTransformOutcome> {
		const { kind, text, language } = request

		// Refused before anything loads; the loaded model's own special tokens can only make the text longer by
		// neutralizing, which transformText checks again.
		if (!transformFits(kind, text)) {
			return { ok: false, error: "too-long" }
		}

		active?.abort()

		const controller = new AbortController()
		const unsubscribe = onAbort(request.signal, () => {
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

			const result = await transformText({
				model: runtime.model,
				kind,
				text,
				language,
				signal: controller.signal,
				onText: request.onText,
				onProgress: ({ processed, total }) => {
					request.onProgress?.(total > 0 ? Math.min(1, processed / total) : 0)
				}
			})

			return { ok: true, ...result }
		} catch (e) {
			if (controller.signal.aborted || e instanceof AssistantAbortError) {
				return { ok: false, error: "cancelled" }
			}

			if (e instanceof TransformTooLongError) {
				return { ok: false, error: "too-long" }
			}

			log.error("assistant", "transform failed", e)

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
