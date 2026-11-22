import type {
	AssistantFormFiller,
	AssistantFormFillOutcome,
	AssistantFormFillRequest,
	AssistantFormulaOutcome,
	AssistantFormulaRequest,
	AssistantFormulaWriter,
	AssistantNotesOutcome,
	AssistantNotesRequest,
	AssistantNotesWriter,
	AssistantTransformer,
	AssistantTransformOutcome,
	AssistantTransformRequest
} from "@/features/assistant/types"

// Where the runtime's one-generation helpers plug in (loop/register.ts), beside the session: the editors' transform UI,
// the sheet's formula helper, the slides' notes draft and the PDF form fill reach the model only through these
// functions, never the runtime.
let transformer: AssistantTransformer | null = null
let formulaWriter: AssistantFormulaWriter | null = null
let notesWriter: AssistantNotesWriter | null = null
let formFiller: AssistantFormFiller | null = null

// Registers `next` into the slot `set` writes; the returned function clears it while it still holds `next`.
function register<T>(next: T, get: () => T | null, set: (value: T | null) => void): () => void {
	set(next)

	return () => {
		if (get() === next) {
			set(null)
		}
	}
}

export function registerAssistantTransformer(next: AssistantTransformer): () => void {
	return register(
		next,
		() => transformer,
		value => {
			transformer = value
		}
	)
}

export function transformAssistantText(request: AssistantTransformRequest): Promise<AssistantTransformOutcome> {
	return transformer === null ? Promise.resolve({ ok: false, error: "model-unavailable" }) : transformer.run(request)
}

export function registerAssistantFormulaWriter(next: AssistantFormulaWriter): () => void {
	return register(
		next,
		() => formulaWriter,
		value => {
			formulaWriter = value
		}
	)
}

export function writeAssistantFormula(request: AssistantFormulaRequest): Promise<AssistantFormulaOutcome> {
	return formulaWriter === null ? Promise.resolve({ ok: false, error: "model-unavailable" }) : formulaWriter.run(request)
}

export function registerAssistantNotesWriter(next: AssistantNotesWriter): () => void {
	return register(
		next,
		() => notesWriter,
		value => {
			notesWriter = value
		}
	)
}

export function draftAssistantNotes(request: AssistantNotesRequest): Promise<AssistantNotesOutcome> {
	return notesWriter === null ? Promise.resolve({ ok: false, error: "model-unavailable" }) : notesWriter.run(request)
}

export function registerAssistantFormFiller(next: AssistantFormFiller): () => void {
	return register(
		next,
		() => formFiller,
		value => {
			formFiller = value
		}
	)
}

export function fillAssistantForm(request: AssistantFormFillRequest): Promise<AssistantFormFillOutcome> {
	return formFiller === null ? Promise.resolve({ ok: false, error: "model-unavailable" }) : formFiller.run(request)
}

// Signing out (shutdownAssistant): whatever helper is running stops and none starts again.
export function shutdownAssistantTransformer(): void {
	transformer?.shutdown()
	formulaWriter?.shutdown()
	notesWriter?.shutdown()
	formFiller?.shutdown()
}
