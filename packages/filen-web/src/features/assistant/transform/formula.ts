import { AssistantAbortError, writeCheckedFormula } from "@filen/shared/assistant"
import type { AssistantRuntimeLike } from "@/features/assistant/loop/session"
import type { AssistantFormulaOutcome, AssistantFormulaRequest, AssistantFormulaWriter } from "@/features/assistant/types"
import { onAbort, raceAbort } from "@/lib/abort"
import { log } from "@/lib/log"

// The spreadsheet formula helper over the on-device model (@filen/shared/assistant writeCheckedFormula), run as the
// selection transform runs (transform/run.ts): the extraction slot, the model held for the generation and loaded
// first when it is only on disk, one request at a time (a new one stops the one before), nothing after signing out.
// The request's `check` is the sheet's: the formula checked, then calculated by its engine.
export function createAssistantFormulaWriter(
	runtime: Pick<AssistantRuntimeLike, "model" | "getState" | "load" | "hold">
): AssistantFormulaWriter {
	let active: AbortController | null = null
	let shutDown = false

	async function run(request: AssistantFormulaRequest): Promise<AssistantFormulaOutcome> {
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

			const outcome = await writeCheckedFormula({
				model: runtime.model,
				context: request.context,
				check: request.check,
				signal: controller.signal,
				onProgress: ({ processed, total }) => {
					request.onProgress?.(total > 0 ? Math.min(1, processed / total) : 0)
				}
			})

			return outcome.ok ? { ok: true, formula: outcome.formula, value: outcome.value } : { ok: false, error: "invalid" }
		} catch (e) {
			if (controller.signal.aborted || e instanceof AssistantAbortError) {
				return { ok: false, error: "cancelled" }
			}

			log.error("assistant", "formula failed", e)

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
