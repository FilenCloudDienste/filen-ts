import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react"
import { useRouterState } from "@tanstack/react-router"
import { shouldCloseDialogOnNavigate } from "@/lib/useDialogHost.logic"

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

export interface UseDialogHostOptions<Dialog> {
	// Opts a dialog kind OUT of the close-on-navigate rule. Must be a stable (module-scope) function —
	// it is an effect dependency. The only consumers are drive/photos' preview overlay, whose
	// unsaved-edit blocker owns what a navigation means for its buffer; closing it from here would
	// throw away edits the blocker deliberately did not prompt for (a same-route splat change).
	keepOpenOnNavigate?: (dialog: Dialog) => boolean
}

export function useDialogHost<Dialog>(options?: UseDialogHostOptions<Dialog>): DialogHost<Dialog> {
	const [activeDialog, setActiveDialog] = useState<Dialog | null>(null)
	const [dialogPending, setDialogPending] = useState(false)
	// `href` (pathname + search + hash), not `pathname` alone: contacts switches sections through a
	// search param on ONE path, so a pathname-keyed rule would miss the one surface that navigates
	// without changing its path.
	const locationHref = useRouterState({ select: state => state.location.href })
	const lastHrefRef = useRef(locationHref)
	const keepOpenOnNavigate = options?.keepOpenOnNavigate

	// Browser back/forward (and any in-app navigation that leaves this host mounted) must not strand an
	// open modal over a screen it no longer belongs to. Pending is respected, so a navigation fired from
	// inside a mutation (notes/chats navigate away from the note being deleted BEFORE its cache removal
	// — useNoteDialogHost's navigateAwayIfCurrent) never yanks the dialog out from under its own
	// spinner; that flow closes itself when it settles.
	useEffect(() => {
		if (lastHrefRef.current === locationHref) {
			return
		}

		lastHrefRef.current = locationHref

		const keepOpen = activeDialog !== null && (keepOpenOnNavigate?.(activeDialog) ?? false)

		if (!shouldCloseDialogOnNavigate({ hasDialog: activeDialog !== null, pending: dialogPending, keepOpen })) {
			return
		}

		// eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate navigation reset, mirrors useDriveListboxNav
		setActiveDialog(null)
	}, [locationHref, activeDialog, dialogPending, keepOpenOnNavigate])

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
