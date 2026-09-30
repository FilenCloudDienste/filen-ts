import { create } from "zustand"
import type { ChatParticipant } from "@filen/sdk-rs"
import { toggleInArray } from "@filen/shared"

export type ChatParticipantsStore = {
	selectedChatParticipants: ChatParticipant[]
	toggleSelectedChatParticipant: (participant: ChatParticipant) => void
	clearSelectedChatParticipants: () => void
	selectAllChatParticipants: (participants: ChatParticipant[]) => void
}

const participantId = (p: ChatParticipant) => p.userId.toString()

export const useChatParticipantsStore = create<ChatParticipantsStore>(set => ({
	selectedChatParticipants: [],
	toggleSelectedChatParticipant(participant) {
		set(state => ({
			selectedChatParticipants: toggleInArray(state.selectedChatParticipants, participant, participantId)
		}))
	},
	clearSelectedChatParticipants() {
		set({ selectedChatParticipants: [] })
	},
	selectAllChatParticipants(participants) {
		set({ selectedChatParticipants: participants })
	}
}))

export default useChatParticipantsStore
