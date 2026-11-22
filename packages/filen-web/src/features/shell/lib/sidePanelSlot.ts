import { createContext, useContext } from "react"

// The shell row's slot after the content card, where a route portals its own side panel (the chat info or note participants panel) so it
// floats beside the card like the assistant does. Null until the row mounts, at narrow widths, and outside the authed
// shell.
export const SidePanelSlotContext = createContext<HTMLElement | null>(null)

export function useSidePanelSlot(): HTMLElement | null {
	return useContext(SidePanelSlotContext)
}
