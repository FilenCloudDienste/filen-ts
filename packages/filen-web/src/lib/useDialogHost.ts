import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react"
import { useRouterState } from "@tanstack/react-router"
import { toast } from "sonner"
import { resolveDialogNavigationClose } from "@/lib/useDialogHost.logic"
import { type VoidActionOutcome } from "@/lib/actions/outcome"
import { type BulkOutcome } from "@/lib/actions/bulk"
import { runBulkActivity, type BulkActivitySpec } from "@/lib/activity/activity"
import { errorLabel } from "@/lib/i18n/errorLabel"

// The listing-level "one dialog at a time" state machine, shared by every feature that hosts a
// kind-discriminated confirm/edit dialog off a list (drive's directory listing, contacts). `Dialog`
// is the host's own full per-kind shape (kind + whatever payload each kind carries — e.g. drive's
// preview index, contacts' bulk flag), so a single type parameter covers it without forcing every
// host's extra fields into a shared {kind, items} shape that not all of them need.
export interface DialogHost<Dialog> {
	activeDialog: Dialog | null
	setActiveDialog: Dispatch<SetStateAction<Dialog | null>>
	dialogPending: boolean
	isDialogOpen: boolean
	closeActiveDialog: () => void
	// Runs a host-owned mutation with `dialogPending` set around it, for tails that need the outcome
	// themselves (bulk confirms close unconditionally and toast their own summary).
	runDialogPending: <T>(op: () => Promise<T>) => Promise<T>
	// The single-target tail: on error toast and keep the dialog open so the user can retry, else close.
	// Resolves true on success, for callers with a post-close step.
	runDialogOutcome: (op: () => Promise<VoidActionOutcome>) => Promise<boolean>
	// A confirmed bulk action: one item keeps the dialog's spinner until it settles, then closes and toasts
	// its result; several close the dialog at once and hand the run to an activity toast counting them.
	runBulkDialogActivity: <T>(spec: BulkActivitySpec<T>) => Promise<BulkOutcome<T>>
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
	// A navigation that arrived mid-mutation owes a close; this remembers it so the effect below can
	// re-decide when `dialogPending` settles instead of dropping it (an error arm keeps its dialog open,
	// which after a navigation is exactly the strand this rule exists to prevent).
	const deferredCloseRef = useRef(false)
	const keepOpenOnNavigate = options?.keepOpenOnNavigate

	// Browser back/forward (and any in-app navigation that leaves this host mounted) must not strand an
	// open modal over a screen it no longer belongs to. Pending is respected, so a navigation fired from
	// inside a mutation (notes/chats navigate away from the note being deleted BEFORE its cache removal
	// — useNoteDialogHost's navigateAwayIfCurrent) never yanks the dialog out from under its own
	// spinner; a flow that closes itself when it settles gets there first and this finds nothing to do.
	useEffect(() => {
		if (lastHrefRef.current === locationHref && !deferredCloseRef.current) {
			return
		}

		lastHrefRef.current = locationHref

		const keepOpen = activeDialog !== null && (keepOpenOnNavigate?.(activeDialog) ?? false)
		const outcome = resolveDialogNavigationClose({ hasDialog: activeDialog !== null, pending: dialogPending, keepOpen })

		deferredCloseRef.current = outcome === "defer"

		if (outcome !== "close") {
			return
		}

		// eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate navigation reset, mirrors useDriveListboxNav
		setActiveDialog(null)
	}, [locationHref, activeDialog, dialogPending, keepOpenOnNavigate])

	function closeActiveDialog(): void {
		setActiveDialog(null)
	}

	async function runDialogPending<T>(op: () => Promise<T>): Promise<T> {
		setDialogPending(true)
		const result = await op()
		setDialogPending(false)

		return result
	}

	// Not built on runDialogPending: its extra await would split the pending reset from the close.
	async function runDialogOutcome(op: () => Promise<VoidActionOutcome>): Promise<boolean> {
		setDialogPending(true)
		const outcome = await op()
		setDialogPending(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))

			return false
		}

		closeActiveDialog()

		return true
	}

	async function runBulkDialogActivity<T>(spec: BulkActivitySpec<T>): Promise<BulkOutcome<T>> {
		if (spec.items.length > 1) {
			closeActiveDialog()

			return await runBulkActivity(spec)
		}

		const outcome = await runDialogPending(() => runBulkActivity({ ...spec, showRunning: false }))

		closeActiveDialog()

		return outcome
	}

	return {
		activeDialog,
		setActiveDialog,
		dialogPending,
		isDialogOpen: activeDialog !== null,
		closeActiveDialog,
		runDialogPending,
		runDialogOutcome,
		runBulkDialogActivity
	}
}
