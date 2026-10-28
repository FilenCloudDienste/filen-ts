import { createContext, useContext } from "react"

// The shell row's bottom-centre anchor: a floating bar portalled here centres on the whole window rather than its
// own card, and still sits above the docked audio player. Null until the row mounts, and outside the authed shell.
export const WindowBarSlotContext = createContext<HTMLElement | null>(null)

export function useWindowBarSlot(): HTMLElement | null {
	return useContext(WindowBarSlotContext)
}
