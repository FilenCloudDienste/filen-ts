import { isOverlayOpenBesides } from "@/lib/keymap/dialogGuard"
import { shouldIgnoreEvent } from "@/lib/keymap/useAction"

// The panel is mounted at most once (inline at desktop widths, or in the narrow-screen drawer, in the shell or in an
// open preview), so fixed ids are unique and let the shell, the toggles and the drawer find each other without
// threading refs.
export const ASSISTANT_PANEL_ID = "assistant-panel"
export const ASSISTANT_TITLE_ID = "assistant-panel-title"
export const ASSISTANT_TOGGLE_ID = "assistant-toggle"
// The open preview's slot for the panel (PreviewAssistantPane), present while the preview hosts it, and its header's
// toggle.
export const ASSISTANT_PREVIEW_HOST_ID = "assistant-preview-host"
export const ASSISTANT_PREVIEW_TOGGLE_ID = "assistant-preview-toggle"

// `data-assistant-autofocus` marks the control that should take focus when the user opens the panel: the
// composer when the model is ready, otherwise the setup screen's primary button.
const AUTOFOCUS_SELECTOR = "[data-assistant-autofocus]"

// The marked control, or the panel itself (focusable via tabIndex -1) when there is none, so focus always
// lands inside the region the user just opened.
export function assistantInitialFocusTarget(panel = document.getElementById(ASSISTANT_PANEL_ID)): HTMLElement | null {
	if (panel === null) {
		return null
	}

	return panel.querySelector<HTMLElement>(AUTOFOCUS_SELECTOR) ?? panel
}

// Closing unmounts the inline panel; focus inside it would fall back to the document body, so it goes to
// the toggle that reopens it first: the open preview's, whose modal dialog makes the rail unreachable, else the
// rail's. Focus elsewhere stays where the user put it.
export function moveFocusOutOfAssistant(): void {
	const panel = document.getElementById(ASSISTANT_PANEL_ID)

	if (panel?.contains(document.activeElement) !== true) {
		return
	}

	const toggle = document.getElementById(ASSISTANT_PREVIEW_TOGGLE_ID) ?? document.getElementById(ASSISTANT_TOGGLE_ID)

	toggle?.focus()
}

// app.toggleAssistant's guard: an open dialog or menu owns the keyboard, but the narrow drawer the panel is shown in
// is a dialog too, and its own key closes it, and so is the preview hosting the panel, whose key toggles it.
export function assistantKeyIgnored(event: Parameters<typeof shouldIgnoreEvent>[0]): boolean {
	return (
		shouldIgnoreEvent(event) ||
		isOverlayOpenBesides(document.getElementById(ASSISTANT_PANEL_ID), document.getElementById(ASSISTANT_PREVIEW_HOST_ID))
	)
}
