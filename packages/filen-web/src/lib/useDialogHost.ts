import { useState, type Dispatch, type SetStateAction } from "react"

// The listing-level "one dialog at a time" state machine, shared by every feature that hosts a
// kind-discriminated confirm/edit dialog off a list (drive's directory listing, contacts). `Dialog`
// is the host's own full per-kind shape (kind + whatever payload each kind carries — e.g. drive's
// preview index, contacts' bulk flag), so a single type parameter covers it without forcing every
// host's extra fields into a shared {kind, items} shape that not all of them need.
export interface DialogHost<Dialog> {
	activeDialog: Dialog | null
	setActiveDialog: Dispatch<SetStateAction<Dialog | null>>
	dialogPending: boolean
	setDialogPending: Dispatch<SetStateAction<boolean>>
	isDialogOpen: boolean
	closeActiveDialog: () => void
}

export function useDialogHost<Dialog>(): DialogHost<Dialog> {
	const [activeDialog, setActiveDialog] = useState<Dialog | null>(null)
	const [dialogPending, setDialogPending] = useState(false)

	function closeActiveDialog(): void {
		setActiveDialog(null)
	}

	return {
		activeDialog,
		setActiveDialog,
		dialogPending,
		setDialogPending,
		isDialogOpen: activeDialog !== null,
		closeActiveDialog
	}
}
