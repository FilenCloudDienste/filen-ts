import { draftSpeakerNotes } from "@filen/shared/assistant"
import type { AssistantNotesOutcome, AssistantNotesRequest, AssistantNotesWriter } from "@/features/assistant/types"
import { createModelRunner, progressShare, type ModelRuntime } from "@/features/assistant/transform/modelRun"

// Speaker notes drafted from a slide's text over the on-device model (@filen/shared/assistant draftSpeakerNotes), run
// as every one-generation helper runs (modelRun.ts).
export function createAssistantNotesWriter(runtime: ModelRuntime): AssistantNotesWriter {
	const runner = createModelRunner(runtime)

	function run(request: AssistantNotesRequest): Promise<AssistantNotesOutcome> {
		return runner.run(request.signal, "speaker notes", async (model, signal): Promise<AssistantNotesOutcome> => {
			const result = await draftSpeakerNotes({
				model,
				slideText: request.slideText,
				signal,
				onText: request.onText,
				onProgress: progressShare(request.onProgress)
			})

			return { ok: true, ...result }
		})
	}

	return { run, shutdown: runner.shutdown }
}
