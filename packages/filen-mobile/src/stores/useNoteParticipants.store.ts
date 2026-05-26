import { create } from "zustand"
import { type NoteParticipant } from "@/types"
import { toggleInArray } from "@/stores/createSelectionSlice"

export type NoteParticipantsStore = {
	selectedNoteParticipants: NoteParticipant[]
	setSelectedNoteParticipants: (
		fn: NoteParticipant[] | ((prev: NoteParticipant[]) => NoteParticipant[])
	) => void
	toggleSelectedNoteParticipant: (participant: NoteParticipant) => void
	clearSelectedNoteParticipants: () => void
	selectAllNoteParticipants: (participants: NoteParticipant[]) => void
}

const participantId = (p: NoteParticipant) => p.userId.toString()

export const useNoteParticipantsStore = create<NoteParticipantsStore>(set => ({
	selectedNoteParticipants: [],
	setSelectedNoteParticipants(fn) {
		set(state => ({
			selectedNoteParticipants: typeof fn === "function" ? fn(state.selectedNoteParticipants) : fn
		}))
	},
	toggleSelectedNoteParticipant(participant) {
		set(state => ({
			selectedNoteParticipants: toggleInArray(state.selectedNoteParticipants, participant, participantId)
		}))
	},
	clearSelectedNoteParticipants() {
		set({ selectedNoteParticipants: [] })
	},
	selectAllNoteParticipants(participants) {
		set({ selectedNoteParticipants: participants })
	}
}))

export default useNoteParticipantsStore
