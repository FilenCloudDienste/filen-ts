import type { AppHelpId } from "@filen/shared/assistant"
import { createListenerSet } from "@/lib/listenerSet"

// A deep link into Settings: the settings page showing this app_help row scrolls it into view and pulses its ring
// (features/settings/hooks/useHelpHighlight.ts). Outside features/settings, so the assistant can ask for one.

// How long a request waits for its row to render (an account page loads first); a request no page took up by then is
// dropped, so a later visit to Settings never highlights a stale row.
export const HELP_HIGHLIGHT_WAIT_MS = 5000

let pending: { id: AppHelpId; at: number } | null = null

const requests = createListenerSet("settings")

export function requestSettingsHighlight(id: AppHelpId): void {
	pending = { id, at: performance.now() }
	requests.emit()
}

// The pending request, once: whoever takes it shows it.
export function takeSettingsHighlight(): AppHelpId | null {
	const request = pending

	pending = null

	return request !== null && performance.now() - request.at < HELP_HIGHLIGHT_WAIT_MS ? request.id : null
}

export function subscribeSettingsHighlight(listener: () => void): () => void {
	return requests.subscribe(listener)
}
