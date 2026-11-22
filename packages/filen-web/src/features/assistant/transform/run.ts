import { transformFits, transformText, TransformTooLongError } from "@filen/shared/assistant"
import type { AssistantTransformer, AssistantTransformOutcome, AssistantTransformRequest } from "@/features/assistant/types"
import { createModelRunner, progressShare, type ModelRuntime } from "@/features/assistant/transform/modelRun"

// The selection transform over the on-device model (@filen/shared/assistant transformText), run as every
// one-generation helper runs (modelRun.ts).
export function createAssistantTransformer(runtime: ModelRuntime): AssistantTransformer {
	const runner = createModelRunner(runtime)

	function run(request: AssistantTransformRequest): Promise<AssistantTransformOutcome> {
		const { kind, text, language } = request

		// Refused before anything loads; the loaded model's own special tokens can only make the text longer by
		// neutralizing, which transformText checks again.
		if (!transformFits(kind, text)) {
			return Promise.resolve({ ok: false, error: "too-long" })
		}

		return runner.run(request.signal, "transform", async (model, signal): Promise<AssistantTransformOutcome> => {
			try {
				const result = await transformText({
					model,
					kind,
					text,
					language,
					signal,
					onText: request.onText,
					onProgress: progressShare(request.onProgress)
				})

				return { ok: true, ...result }
			} catch (e) {
				if (e instanceof TransformTooLongError) {
					return { ok: false, error: "too-long" }
				}

				throw e
			}
		})
	}

	return { run, shutdown: runner.shutdown }
}
