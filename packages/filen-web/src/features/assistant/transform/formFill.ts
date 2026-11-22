import { fillFormFields, formFillDetailsFit, FormFillTooLongError } from "@filen/shared/assistant"
import type { AssistantFormFiller, AssistantFormFillOutcome, AssistantFormFillRequest } from "@/features/assistant/types"
import { createModelRunner, progressShare, type ModelRuntime } from "@/features/assistant/transform/modelRun"
import { log } from "@/lib/log"

// A form page filled from the user's details over the on-device model (@filen/shared/assistant fillFormFields), run
// as every one-generation helper runs (modelRun.ts). The details are the user's own: never logged or kept (the log
// line carries counts only).
export function createAssistantFormFiller(runtime: ModelRuntime): AssistantFormFiller {
	const runner = createModelRunner(runtime)

	function run(request: AssistantFormFillRequest): Promise<AssistantFormFillOutcome> {
		// Refused before anything loads.
		if (!formFillDetailsFit(request.details)) {
			return Promise.resolve({ ok: false, error: "too-long" })
		}

		return runner.run(request.signal, "form fill", async (model, signal): Promise<AssistantFormFillOutcome> => {
			try {
				const result = await fillFormFields({
					model,
					fields: request.fields,
					details: request.details,
					signal,
					onProgress: progressShare(request.onProgress)
				})

				log.info(
					"assistant",
					`form fill: ${String(result.offered.length)} offered, ${String(result.fill.length)} filled, ${String(result.dropped.length)} dropped`
				)

				return { ok: true, ...result }
			} catch (e) {
				if (e instanceof FormFillTooLongError) {
					return { ok: false, error: "too-long" }
				}

				throw e
			}
		})
	}

	return { run, shutdown: runner.shutdown }
}
