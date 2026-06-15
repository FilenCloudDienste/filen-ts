import { create } from "zustand"

type RevealedBlockedMessagesState = {
	revealed: Set<string>
	reveal: (uuid: string) => void
	clear: () => void
}

// Ephemeral, per-session reveal state for tombstoned blocked messages. NOT persisted.
// Cleared when leaving a chat so re-entering re-hides them.
const useRevealedBlockedMessages = create<RevealedBlockedMessagesState>(set => ({
	revealed: new Set<string>(),
	reveal: uuid =>
		set(state => {
			const next = new Set(state.revealed)

			next.add(uuid)

			return {
				revealed: next
			}
		}),
	clear: () =>
		set(() => ({
			revealed: new Set<string>()
		}))
}))

export default useRevealedBlockedMessages
