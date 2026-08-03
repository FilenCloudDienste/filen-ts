import { create } from "zustand"

interface RevealedBlockedMessagesState {
	revealed: ReadonlySet<string>
	reveal: (uuid: string) => void
	clear: () => void
}

// Message uuids the reader has explicitly revealed past a blocked-sender tombstone. Ephemeral per session,
// never persisted, cleared when the open conversation changes. A store rather than row-local state because
// the thread virtualizer recycles rows — local state would reset on scroll.
export const useRevealedBlockedMessages = create<RevealedBlockedMessagesState>(set => ({
	revealed: new Set<string>(),
	reveal: uuid => {
		set(state => {
			// Avoid a needless state update (and re-render) when this uuid is already revealed.
			if (state.revealed.has(uuid)) {
				return state
			}

			return { revealed: new Set([...state.revealed, uuid]) }
		})
	},
	clear: () => {
		set({ revealed: new Set<string>() })
	}
}))
