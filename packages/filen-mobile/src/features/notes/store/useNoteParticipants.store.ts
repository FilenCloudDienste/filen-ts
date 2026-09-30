import { create } from "zustand"
import { type NoteParticipant } from "@/types"
import { toggleInArray } from "@filen/shared"

export type NoteParticipantsStore = {
	selectedNoteParticipants: NoteParticipant[]
	toggleSelectedNoteParticipant: (participant: NoteParticipant) => void
	clearSelectedNoteParticipants: () => void
	selectAllNoteParticipants: (participants: NoteParticipant[]) => void
}

const participantId = (p: NoteParticipant) => p.userId.toString()

export const useNoteParticipantsStore = create<NoteParticipantsStore>(set => ({
	selectedNoteParticipants: [],
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
