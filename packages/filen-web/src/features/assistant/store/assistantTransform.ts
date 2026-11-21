import type { AssistantTransformer, AssistantTransformOutcome, AssistantTransformRequest } from "@/features/assistant/types"

// Where the runtime's selection transform plugs in (loop/register.ts), beside the session: the editors' transform UI
// reaches the model only through these functions, never the runtime.
let transformer: AssistantTransformer | null = null

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

// Signing out (shutdownAssistant): the running transform stops and none starts again.
export function shutdownAssistantTransformer(): void {
	transformer?.shutdown()
}
