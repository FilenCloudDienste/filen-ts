import type { AssistantModel } from "@filen/shared/assistant"
import { ASSISTANT_CONTEXT_TOKENS } from "@/features/assistant/runtime/client"
import { createAssistantSession, type AssistantRuntimeLike } from "@/features/assistant/loop/session"
import { registerAssistantSession } from "@/features/assistant/store/assistantSession"
import {
	registerAssistantFormFiller,
	registerAssistantFormulaWriter,
	registerAssistantNotesWriter,
	registerAssistantTransformer
} from "@/features/assistant/store/assistantTransform"
import { createAssistantToolExecutor } from "@/features/assistant/tools/executor"
import { createAssistantFormFiller } from "@/features/assistant/transform/formFill"
import { createAssistantFormulaWriter } from "@/features/assistant/transform/formula"
import { createAssistantNotesWriter } from "@/features/assistant/transform/speakerNotes"
import { createAssistantTransformer } from "@/features/assistant/transform/run"
import type { AssistantModelState } from "@/features/assistant/types"
import { assistantStubGenerate, loadAssistantStubScript, type AssistantStubScript } from "@/e2e-hooks/assistantStubModel"
import { noop } from "@/lib/utils"

export { assistantStubRequests, type AssistantStubRequest, type AssistantStubScript } from "@/e2e-hooks/assistantStubModel"

// Plugs the scripted model (assistantStubModel.ts) in place of the on-device runtime, which is always ready: no
// download, no worker, no device check. Installed only in VITE_E2E builds (e2e-hooks), so nothing here ships.
const STUB_MODEL_INFO = {
	id: "e2e-stub",
	name: "E2E stub",
	sizeBytes: 1
}

const READY: AssistantModelState = { kind: "ready", model: STUB_MODEL_INFO }

const stubModel: AssistantModel = {
	contextTokens: ASSISTANT_CONTEXT_TOKENS,
	specialTokens: [],
	generate: assistantStubGenerate
}

let installed = false

const stubRuntime: AssistantRuntimeLike = {
	model: stubModel,
	getState: () => READY,
	subscribe: listener => {
		listener(READY)

		return noop
	},
	init: () => Promise.resolve(),
	setPanelOpen: noop,
	load: () => Promise.resolve(),
	touch: noop,
	retry: noop,
	resumeInterruptedDownload: noop,
	cancelDownload: noop,
	deleteModel: () => Promise.resolve(),
	hold: () => noop,
	shutdown: noop
}

// loadAssistantStubScript; the first call also plugs the stub in place of the on-device runtime: a new session over
// the real tool executor, the transform, the formula writer, the notes writer and the form filler.
export function setAssistantStubScript(next: AssistantStubScript): void {
	loadAssistantStubScript(next)

	if (installed) {
		return
	}

	installed = true
	registerAssistantSession(createAssistantSession({ runtime: stubRuntime, executor: createAssistantToolExecutor() }))
	registerAssistantTransformer(createAssistantTransformer(stubRuntime))
	registerAssistantFormulaWriter(createAssistantFormulaWriter(stubRuntime))
	registerAssistantNotesWriter(createAssistantNotesWriter(stubRuntime))
	registerAssistantFormFiller(createAssistantFormFiller(stubRuntime))
}
