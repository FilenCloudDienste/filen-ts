import { create } from "zustand"

interface UploadDropTarget {
	owner: object
	name: string
}

interface UploadDropTargetState {
	target: UploadDropTarget | null
	setTarget: (target: UploadDropTarget) => void
	// Only the owner clears, so a leave landing after the next target's enter can't wipe that one.
	clearTarget: (owner: object) => void
}

// The directory an OS file drag currently rests on, named in the listing's upload overlay
// (uploadDropzone.tsx) so the drop's destination reads at a glance.
export const useUploadDropTargetStore = create<UploadDropTargetState>(set => ({
	target: null,
	setTarget: target => {
		set({ target })
	},
	clearTarget: owner => {
		set(state => (state.target?.owner === owner ? { target: null } : state))
	}
}))
