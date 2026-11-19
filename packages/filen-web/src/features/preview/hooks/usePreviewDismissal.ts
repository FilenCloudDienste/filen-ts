import { useCallback, useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react"
import { useBlocker, type ShouldBlockFn } from "@tanstack/react-router"
import type { DriveItem } from "@/features/drive/lib/item"
import {
	previewNavigationUnmountsOverlay,
	resolveUnsavedConfirm,
	type PreviewDismissIntent
} from "@/features/preview/components/previewOverlay.logic"
import type { ImageEditState } from "@/features/preview/imageEdit/editSession"
import type { TextBuffer } from "@/features/preview/lib/textFile"
import {
	dropPreviewBuffer,
	usePreviewUnsavedGuardStore,
	type PreviewUnsavedGuardStore
} from "@/features/preview/store/usePreviewUnsavedGuard"
import type { VideoEditState } from "@/features/preview/videoEdit/useVideoEditMode"
import { holdUnload } from "@/lib/unloadGuard"
import { useLatestRef } from "@/lib/useLatestRef"

// Module scope, not an inline arrow: useBlocker's registration effect lists shouldBlockFn in its own
// deps, so a per-render identity would unregister/re-register the history blocker on every render.
const blockWhenLeavingRoute: ShouldBlockFn = ({ current, next }) => previewNavigationUnmountsOverlay(current.routeId, next.routeId)

interface UsePreviewDismissalParams {
	items: readonly DriveItem[]
	driveItem: DriveItem | undefined
	editing: ImageEditState | null
	videoEditing: VideoEditState | null
	dirty: boolean
	saving: boolean
	logoutRequest: PreviewUnsavedGuardStore["logoutRequest"]
	pendingIntent: PreviewDismissIntent | null
	setPendingIntent: Dispatch<SetStateAction<PreviewDismissIntent | null>>
	pendingReplaceRef: RefObject<(() => void) | null>
	contentRef: RefObject<TextBuffer | null>
	requestOrRun: (intent: PreviewDismissIntent, run: () => void) => void
	requestExitImageEdit: () => void
	requestExitVideoEdit: () => void
	exitImageEdit: () => void
	exitVideoEdit: () => void
	onClose: () => void
	onStep: (delta: number) => void
}

// The preview overlay's (PreviewOverlay) ways out while it holds unsaved edits: the browser's Back, a navigation that
// unmounts it, a tab close and a waiting sign-out, and the answers of the unsaved-changes prompt they open.
export function usePreviewDismissal({
	items,
	driveItem,
	editing,
	videoEditing,
	dirty,
	saving,
	logoutRequest,
	pendingIntent,
	setPendingIntent,
	pendingReplaceRef,
	contentRef,
	requestOrRun,
	requestExitImageEdit,
	requestExitVideoEdit,
	exitImageEdit,
	exitVideoEdit,
	onClose,
	onStep
}: UsePreviewDismissalParams) {
	useEffect(() => {
		return () => {
			usePreviewUnsavedGuardStore.getState().clear()
		}
	}, [])

	// The browser's Back closes the preview and stays where it was opened, rather than moving the page
	// underneath it: the overlay is not a history entry, so Back would otherwise leave the listing (or the
	// route) while the preview stayed up. Registered before the unsaved-changes blocker below so a Back
	// raises only the close path's own prompt. The close runs through a ref so the blocker registers once.
	const requestCloseRef = useLatestRef(() => {
		// In edit mode Back leaves edit mode instead, as the header's Cancel does.
		if (editing !== null) {
			requestExitImageEdit()

			return
		}

		if (videoEditing !== null) {
			requestExitVideoEdit()

			return
		}

		requestOrRun("close", onClose)
	})
	const closeOnBack = useCallback<ShouldBlockFn>(
		({ action }) => {
			if (action !== "BACK") {
				return false
			}

			requestCloseRef.current()

			return true
		},
		[requestCloseRef]
	)

	useBlocker({ shouldBlockFn: closeOnBack, enableBeforeUnload: false })

	// Browser-level guard for the two vectors the in-app requestOrRun path cannot see: a tab
	// refresh/close (the app's one leave-page listener, which excuses its own downloads — the router's
	// would prompt on them) and any navigation that unmounts this overlay's route body. Armed ONLY while
	// the buffer is dirty AND a slot is actually rendered: without the second term a vanished slot (the overlay's early
	// return → no ConfirmDialog in the tree) could block a navigation nothing can then resolve,
	// leaving the blocker's own promise unsettled after the popstate already moved the URL.
	const guardsUnsaved = dirty && driveItem !== undefined
	const blocker = useBlocker({
		shouldBlockFn: blockWhenLeavingRoute,
		enableBeforeUnload: false,
		disabled: !guardsUnsaved,
		withResolver: true
	})

	useEffect(() => (guardsUnsaved ? holdUnload() : undefined), [guardsUnsaved])

	// A save in flight must never reach the prompt: Discard would release the navigation while the
	// un-cancellable upload still lands and patches the listing with exactly the content the user just
	// chose to drop. Cancelling the block outright is the same refusal requestOrRun applies to the in-app
	// routes (close/prev/next) — the navigation is simply repeatable once the save settles.
	useEffect(() => {
		if (saving && blocker.status === "blocked") {
			blocker.reset()
		}
	}, [saving, blocker])

	// A sign-out waits for a save in flight to settle before anything is asked: a discard answered meanwhile
	// could not stop the upload (the editor's writing, or the upload itself, is already under way). Saved
	// and clean by then, it proceeds with nothing to lose; otherwise the prompt asks as usual.
	const logoutAsks = logoutRequest !== null && !saving
	// The sign-out waiting now waited for a save.
	const waitedForSaveRef = useRef<object | null>(null)

	useEffect(() => {
		if (logoutRequest === null) {
			return
		}

		if (saving) {
			waitedForSaveRef.current = logoutRequest

			return
		}

		if (waitedForSaveRef.current !== logoutRequest || dirty) {
			return
		}

		logoutRequest.resolve(true)
		usePreviewUnsavedGuardStore.getState().setLogoutRequest(null)
		onClose()
	}, [logoutRequest, saving, dirty, onClose])

	function handleUnsavedConfirm(): void {
		// Never while a save is in flight: what it writes would still be uploaded after the user discarded it.
		if (saving) {
			return
		}

		const actions = resolveUnsavedConfirm(pendingIntent, blocker.status === "blocked", logoutAsks)

		setPendingIntent(null)
		// The buffer is gone by the user's own choice: drop the dirty bit and the stale content with it.
		// The overlay's slot-change effect cannot cover this one — a discarded "close" answer changes no slot,
		// and a discarded prev/next must be clean BEFORE the step, not after it.
		dropPreviewBuffer(contentRef)

		// `logoutRequest !== null` is re-tested (not read off `actions` alone) so TS narrows it — same
		// reason `blocker.status` is re-tested below.
		if (actions.proceedLogout && logoutRequest !== null) {
			logoutRequest.resolve(true)
			usePreviewUnsavedGuardStore.getState().setLogoutRequest(null)
			// Closing is what makes the sign-out deterministic rather than timing-dependent: the editor
			// unmounts here, so nothing can re-dirty the buffer (and re-arm beforeunload) during the wipe
			// that follows, which stays fully interactive until its final reload.
			onClose()
		}

		if (actions.proceedNavigation && blocker.status === "blocked") {
			blocker.proceed()
		}

		if (actions.intent === "close") {
			onClose()
		} else if (actions.intent === "prev") {
			onStep(-1)
		} else if (actions.intent === "next") {
			onStep(1)
		} else if (actions.intent === "first") {
			// Clamped to the ends by the host's step (stepPreviewIndex).
			onStep(-items.length)
		} else if (actions.intent === "last") {
			onStep(items.length)
		} else if (actions.intent === "replace") {
			pendingReplaceRef.current?.()
		} else if (actions.intent === "exitEdit") {
			if (videoEditing !== null) {
				exitVideoEdit()
			} else {
				exitImageEdit()
			}
		}

		pendingReplaceRef.current = null
	}

	// The prompt's Cancel (or its dismissal).
	function handleUnsavedOpenChange(open: boolean): void {
		if (!open) {
			setPendingIntent(null)

			// Cancel settles every live waiter with "don't proceed" — the mirror image of
			// confirm — so neither promise can strand.
			if (blocker.status === "blocked") {
				blocker.reset()
			}

			if (logoutRequest !== null) {
				logoutRequest.resolve(false)
				usePreviewUnsavedGuardStore.getState().setLogoutRequest(null)
			}
		}
	}

	return { blocker, logoutAsks, handleUnsavedConfirm, handleUnsavedOpenChange }
}
