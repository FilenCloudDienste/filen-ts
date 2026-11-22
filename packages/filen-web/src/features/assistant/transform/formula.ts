import { writeCheckedFormula } from "@filen/shared/assistant"
import type { AssistantFormulaOutcome, AssistantFormulaRequest, AssistantFormulaWriter } from "@/features/assistant/types"
import { createModelRunner, progressShare, type ModelRuntime } from "@/features/assistant/transform/modelRun"

// The spreadsheet formula helper over the on-device model (@filen/shared/assistant writeCheckedFormula), run as every
// one-generation helper runs (modelRun.ts). The request's `check` is the sheet's: the formula checked, then calculated
// by its engine.
export function createAssistantFormulaWriter(runtime: ModelRuntime): AssistantFormulaWriter {
	const runner = createModelRunner(runtime)

	function run(request: AssistantFormulaRequest): Promise<AssistantFormulaOutcome> {
		return runner.run(request.signal, "formula", async (model, signal): Promise<AssistantFormulaOutcome> => {
			const outcome = await writeCheckedFormula({
				model,
				context: request.context,
				check: request.check,
				signal,
				onProgress: progressShare(request.onProgress)
			})

			return outcome.ok ? { ok: true, formula: outcome.formula, value: outcome.value } : { ok: false, error: "invalid" }
		})
	}

	return { run, shutdown: runner.shutdown }
}
