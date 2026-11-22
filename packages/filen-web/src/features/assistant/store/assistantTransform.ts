import type {
	AssistantFormulaOutcome,
	AssistantFormulaRequest,
	AssistantFormulaWriter,
	AssistantTransformer,
	AssistantTransformOutcome,
	AssistantTransformRequest
} from "@/features/assistant/types"

// Where the runtime's selection transform and formula writer plug in (loop/register.ts), beside the session: the
// editors' transform UI and the sheet's formula helper reach the model only through these functions, never the runtime.
let transformer: AssistantTransformer | null = null
let formulaWriter: AssistantFormulaWriter | null = null

export function registerAssistantTransformer(next: AssistantTransformer): () => void {
	transformer = next

	return () => {
		if (transformer === next) {
			transformer = null
		}
	}
}

export function transformAssistantText(request: AssistantTransformRequest): Promise<AssistantTransformOutcome> {
	return transformer === null ? Promise.resolve({ ok: false, error: "model-unavailable" }) : transformer.run(request)
}

export function registerAssistantFormulaWriter(next: AssistantFormulaWriter): () => void {
	formulaWriter = next

	return () => {
		if (formulaWriter === next) {
			formulaWriter = null
		}
	}
}

export function writeAssistantFormula(request: AssistantFormulaRequest): Promise<AssistantFormulaOutcome> {
	return formulaWriter === null ? Promise.resolve({ ok: false, error: "model-unavailable" }) : formulaWriter.run(request)
}

// Signing out (shutdownAssistant): the running transform or formula stops and none starts again.
export function shutdownAssistantTransformer(): void {
	transformer?.shutdown()
	formulaWriter?.shutdown()
}
