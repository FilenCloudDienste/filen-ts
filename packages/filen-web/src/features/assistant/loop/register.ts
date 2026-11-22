import { registerAssistantSession } from "@/features/assistant/store/assistantSession"
import { registerAssistantFormulaWriter, registerAssistantTransformer } from "@/features/assistant/store/assistantTransform"
import { AssistantRuntime } from "@/features/assistant/runtime/client"
import { createAssistantSession } from "@/features/assistant/loop/session"
import { createAssistantToolExecutor } from "@/features/assistant/tools/executor"
import { createAssistantFormulaWriter } from "@/features/assistant/transform/formula"
import { createAssistantTransformer } from "@/features/assistant/transform/run"

// Importing this module (main.tsx) plugs the on-device runtime into the assistant UI. Nothing heavy
// happens here: once the page is idle the runtime checks the browser's features and lists the model's
// OPFS file sizes. The worker starts only on a download or a load the user asked for, never on its own.
export const assistantRuntime = new AssistantRuntime()

export const assistantSession = createAssistantSession({ runtime: assistantRuntime, executor: createAssistantToolExecutor() })

registerAssistantSession(assistantSession)
registerAssistantTransformer(createAssistantTransformer(assistantRuntime))
registerAssistantFormulaWriter(createAssistantFormulaWriter(assistantRuntime))

const check = () => {
	void assistantRuntime.init()
}

if (typeof requestIdleCallback === "function") {
	requestIdleCallback(check, { timeout: 5000 })
} else {
	setTimeout(check, 2000)
}
