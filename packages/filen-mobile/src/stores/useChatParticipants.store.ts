import { create } from "zustand"
import type { ChatParticipant } from "@filen/sdk-rs"
import { toggleInArray } from "@/stores/createSelectionSlice"

export type ChatParticipantsStore = {
	selectedChatParticipants: ChatParticipant[]
	setSelectedChatParticipants: (
		fn: ChatParticipant[] | ((prev: ChatParticipant[]) => ChatParticipant[])
	) => void
	toggleSelectedChatParticipant: (participant: ChatParticipant) => void
	clearSelectedChatParticipants: () => void
	selectAllChatParticipants: (participants: ChatParticipant[]) => void
}

const participantId = (p: ChatParticipant) => p.userId.toString()

export const useChatParticipantsStore = create<ChatParticipantsStore>(set => ({
	selectedChatParticipants: [],
	setSelectedChatParticipants(fn) {
		set(state => ({
			selectedChatParticipants: typeof fn === "function" ? fn(state.selectedChatParticipants) : fn
		}))
	},
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
