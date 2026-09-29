import { useEffect, type Dispatch, type SetStateAction } from "react"
import {
	reconcilePreviewDialog,
	removePreviewDialogItem,
	stepPreviewDialog,
	subscribePreviewReconcile,
	type PreviewDialogFields
} from "@/features/preview/lib/previewReconcile"

// The preview overlay owns its own navigation semantics: its dirty-buffer guard decides what a route
// change means for unsaved edits, and a same-route splat change deliberately keeps it mounted with the
// buffer intact. Closing it from the dialog host would silently discard exactly what that guard exists
// to protect.
export function keepPreviewOpenOnNavigate(dialog: { kind: string }): boolean {
	return dialog.kind === "preview"
}

export interface PreviewDialogState {
	// PreviewOverlay's onStep: the header's prev/next buttons and its own in-dialog arrow keys.
	stepPreview: (delta: 1 | -1) => void
	// PreviewOverlay's onItemRemoved, after its item menu trashed, deleted or restored the previewed item.
	removeCurrentPreviewItem: (frozenUuid: string) => void
}

// The preview pager shared by the drive and photos dialog hosts. The pager steps a frozen items snapshot
// the socket handler's listing-cache patch can't reach, so the drive socket handler emits reconcile
// events instead, folded in here; at most one host is mounted at a time and the bus tolerates several
// subscribers anyway. setActiveDialog is a stable setState, so the subscription is set up once.
export function usePreviewDialogState<D extends PreviewDialogFields>(
	setActiveDialog: Dispatch<SetStateAction<D | null>>
): PreviewDialogState {
	useEffect(() => {
		return subscribePreviewReconcile(event => {
			setActiveDialog(prev => reconcilePreviewDialog(prev, event))
		})
	}, [setActiveDialog])

	function stepPreview(delta: 1 | -1): void {
		setActiveDialog(prev => stepPreviewDialog(prev, delta))
	}

	function removeCurrentPreviewItem(frozenUuid: string): void {
		setActiveDialog(prev => removePreviewDialogItem(prev, frozenUuid))
	}

	return { stepPreview, removeCurrentPreviewItem }
}
