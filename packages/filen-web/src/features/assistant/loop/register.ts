import { closeHiddenAssistant, registerAssistantSession } from "@/features/assistant/store/assistantSession"
import { assistantHidden, assistantHiddenPreference, assistantHiddenRead } from "@/features/assistant/store/assistantHidden"
import {
	registerAssistantFormFiller,
	registerAssistantFormulaWriter,
	registerAssistantNotesWriter,
	registerAssistantTransformer
} from "@/features/assistant/store/assistantTransform"
import { AssistantRuntime } from "@/features/assistant/runtime/client"
import { createAssistantSession } from "@/features/assistant/loop/session"
import { createAssistantToolExecutor } from "@/features/assistant/tools/executor"
import { createAssistantFormFiller } from "@/features/assistant/transform/formFill"
import { createAssistantFormulaWriter } from "@/features/assistant/transform/formula"
import { createAssistantTransformer } from "@/features/assistant/transform/run"
import { createAssistantNotesWriter } from "@/features/assistant/transform/speakerNotes"

// Importing this module (main.tsx) plugs the on-device runtime into the assistant UI. Nothing heavy
// happens here: once the page is idle the runtime checks the browser's features and lists the model's
// OPFS file sizes. The worker starts only on a download or a load the user asked for, never on its own.
// While the user hides the assistant (Settings > Assistant) not even the check runs.
export const assistantRuntime = new AssistantRuntime()

export const assistantSession = createAssistantSession({ runtime: assistantRuntime, executor: createAssistantToolExecutor() })

registerAssistantSession(assistantSession)
registerAssistantTransformer(createAssistantTransformer(assistantRuntime))
registerAssistantFormulaWriter(createAssistantFormulaWriter(assistantRuntime))
registerAssistantNotesWriter(createAssistantNotesWriter(assistantRuntime))
registerAssistantFormFiller(createAssistantFormFiller(assistantRuntime))

let idle = false

const check = () => {
	// After boot read whether the assistant is hidden.
	void assistantHiddenRead.then(() => {
		idle = true

		if (!assistantHidden()) {
			void assistantRuntime.init()
		}
	})
}

// Hidden mid-session: the panel closes, the turn, a download and the model in memory go. Shown again: the check runs.
assistantHiddenPreference.subscribe(() => {
	if (assistantHidden()) {
		closeHiddenAssistant()
		assistantRuntime.cancelDownload()
		void assistantRuntime.unload()
	} else if (idle) {
		void assistantRuntime.init()
	}
})

if (typeof requestIdleCallback === "function") {
	requestIdleCallback(check, { timeout: 5000 })
} else {
	setTimeout(check, 2000)
}
