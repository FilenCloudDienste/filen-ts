import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import { assistantRunsHere, transformOffered } from "@/features/assistant/transform/transform.logic"

// The one place the assistant's ✨ entry points ask whether to show: the runtime's own device verdict (its startup
// check, read from the model state; nothing is probed again). A device that can never run the model shows none of them;
// a model not downloaded, loading or in use in another tab still shows them and explains on use.

// Whether the assistant can run on this device at all (the preview's assistant toggle).
export function useAssistantRunsHere(): boolean {
	return useAssistantStore(state => assistantRunsHere(state.modelState))
}

// Whether a one-generation helper is offered (✨ beside a selection, the slide and PDF entries, the formula bar).
export function useTransformOffered(): boolean {
	return useAssistantStore(state => transformOffered(state.modelState))
}
