import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import { useAssistantHidden } from "@/features/assistant/store/assistantHidden"
import { assistantRunsHere, transformOffered } from "@/features/assistant/transform/transform.logic"

// The one place the assistant's ✨ entry points ask whether to show: hidden by the user (Settings > Assistant) shows
// none, else the runtime's own device verdict (its startup check, read from the model state; nothing is probed
// again). A device that can never run the model shows none of them; a model not downloaded, loading or in use in
// another tab still shows them and explains on use.

// Whether the assistant can run on this device at all (the preview's assistant toggle).
export function useAssistantRunsHere(): boolean {
	const hidden = useAssistantHidden()
	const runs = useAssistantStore(state => assistantRunsHere(state.modelState))

	return !hidden && runs
}

// Whether a one-generation helper is offered (✨ beside a selection, the slide and PDF entries, the formula bar).
export function useTransformOffered(): boolean {
	const hidden = useAssistantHidden()
	const offered = useAssistantStore(state => transformOffered(state.modelState))

	return !hidden && offered
}
