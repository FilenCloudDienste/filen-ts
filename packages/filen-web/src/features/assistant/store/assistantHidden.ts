import { type } from "arktype"
import { useSyncExternalStore } from "react"
import { preloadedPreference } from "@/lib/storage/preloadedPreference"

// Whether the user hid the assistant (Settings > Assistant). The setting itself is synced with the office settings
// (`hideAssistant`, features/office/lib/officeSettings.ts); this device keeps the value last seen there, read during
// boot (lib/sdk/boot.ts), so the first render already hides every entry point and the model check never starts.
export const assistantHiddenPreference = preloadedPreference<boolean>({
	key: "assistant.v1.hidden",
	schema: type("boolean"),
	fallback: false,
	scope: "assistant",
	same: (a, b) => a === b
})

export const assistantHidden = assistantHiddenPreference.get

let settle: () => void = () => undefined

// Resolves once boot read the stored value: the runtime's startup check waits for it (loop/register.ts).
export const assistantHiddenRead = new Promise<void>(resolve => {
	settle = resolve
})

export function loadAssistantHidden(): Promise<void> {
	return assistantHiddenPreference.load().finally(settle)
}

export function useAssistantHidden(): boolean {
	return useSyncExternalStore(assistantHiddenPreference.subscribe, assistantHiddenPreference.get, assistantHiddenPreference.get)
}
