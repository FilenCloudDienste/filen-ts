import { useEffect, useRef, useState, lazy, Suspense, Component, type KeyboardEvent, type ReactNode, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { XIcon, ChevronLeftIcon, ChevronRightIcon, DownloadIcon, SaveIcon, MoreHorizontalIcon } from "lucide-react"
import { toast } from "sonner"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { previewCategoryForName, previewType } from "@/features/drive/lib/preview.logic"
import { startDownloads } from "@/features/drive/lib/download"
import { isEditable, isUnresolvableParentError, runPreviewSave } from "@/features/drive/lib/previewSave.logic"
import { currentRootUuid, renameItem, trashItems, deleteItemsPermanently } from "@/features/drive/lib/actions"
import { unshareItems } from "@/features/drive/lib/share/actions"
import { driveListingQueryUpdate } from "@/features/drive/queries/drive"
import { toastBulkOutcome } from "@/features/drive/lib/bulkToast"
import { sdkApi } from "@/lib/sdk/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { registerAction } from "@/lib/keymap/registry"
import { useAction } from "@/lib/keymap/useAction"
import { log } from "@/lib/log"
import { useIsOnline } from "@/lib/useIsOnline"
import { ImageViewer, ZoomableImage } from "@/features/preview/components/imageViewer"
import { MediaViewer, MediaElement } from "@/features/preview/components/mediaViewer"
import { isTextEditingTarget, previewMenuVisible, PREVIEW_MENU_HIDDEN_ACTION_IDS } from "@/features/preview/components/previewOverlay.logic"
import { type PreviewSource, previewSourceKey, previewSourceName } from "@/features/preview/lib/previewSource"
import { clearVideoPlaybackStates } from "@/features/preview/lib/videoContinuity"
import { DriveDropdownMenuContent } from "@/features/drive/components/itemMenu"
import { type ItemActionDialogKind } from "@/features/drive/components/itemMenu.logic"
import { MoveTargetDialog } from "@/features/drive/components/moveTargetDialog"
import { InfoDialog } from "@/features/drive/components/infoDialog"
import { LinkDialog } from "@/features/drive/components/linkDialog"
import { ContactPickerDialog } from "@/features/drive/components/contactPickerDialog"
import { VersionsDialog } from "@/features/drive/components/versionsDialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

// Lazy chunks: pdf.js (~1MB+), docx-preview, CodeMirror (+ its per-language grammar chunks) and
// react-markdown only ever download once a file needing them is actually opened, never on the app's
// own initial bundle (image/video/audio all stream or buffer directly, no heavy renderer library
// involved). markdownViewer.tsx's own "view source" toggle lazy-imports TextViewer a second time —
// the same underlying chunk as this one, deduped by the bundler.
const PdfViewer = lazy(() => import("@/features/preview/components/pdfViewer"))
const DocxViewer = lazy(() => import("@/features/preview/components/docxViewer"))
const TextViewer = lazy(() => import("@/features/preview/components/textViewer"))
const MarkdownViewer = lazy(() => import("@/features/preview/components/markdownViewer"))

// Cmd/Ctrl+S — SHARES its literal combo with the already-registered "drive.download" (mod+s,
// directoryListing.tsx), deliberately: that action's own handler already no-ops (after an
// unconditional preventDefault, which is what actually suppresses the browser's native Save-Page-As)
// whenever a dialog — this one included — is open, so the two never race for real effect, only for
// the harmless preventDefault. `enableOnContentEditable` is load-bearing: react-hotkeys-hook's default
// ignore-list stops a hotkey whose event target is contentEditable (verified against the installed
// package's own compiled source), and CodeMirror's own content DOM sets `contenteditable="true"` while
// editable — without this override, Cmd/Ctrl+S would silently never fire while the cursor is actually
// inside the editor, exactly the moment a user would press it.
registerAction({
	id: "preview.save",
	defaultCombo: "mod+s",
	scope: "editor",
	descriptionKey: "previewSaveAction"
})

export interface PreviewOverlayProps {
	variant: DriveVariant
	// Frozen previewable-sibling snapshot taken at open time (directoryListing.tsx's handleOpen) — the
	// pager's whole candidate list, not just the opened item. A PreviewSource[] so the overlay is agnostic
	// to where each slot came from: today every caller emits the drive arm (behaviorally identical to the
	// prior DriveItem[] flow), the external arm is the seam for future chat/note attachments.
	items: PreviewSource[]
	index: number
	onStep: (delta: 1 | -1) => void
	onClose: () => void
	// Trash/delete-permanently/restore-from-trash on the CURRENTLY VIEWED item, run from the header's own
	// item menu below — the host owns the frozen pager list, so it (not this component) drops the slot
	// and either steps to a neighbour or closes outright once none remain (useDriveDialogHost's
	// removeCurrentPreviewItem, mirroring new mobile's driveItemRemoved gallery subscriber). Unshare uses
	// the plain `onClose` above instead — new mobile dismisses the whole preview immediately for that one
	// rather than stepping to a neighbour (menuActions.ts's own dismissOnSuccess: isPreview === true).
	onItemRemoved: () => void
}

// True while focus sits on (or inside) a <video>/<audio> element — its own native controls own
// Left/Right as a seek, so the pager below must not steal them. `instanceof` also covers the "target
// can be a non-Element EventTarget" case for free (null/Document/etc. all just return false), unlike a
// closest() call that would need its own Element check first. The user-agent shadow root the native
// `controls` UI renders into retargets any bubbled event's `target` back to this host element anyway,
// so no tree walk is needed even for a click on the scrubber itself.
function isMediaTarget(target: EventTarget | null): boolean {
	return target instanceof HTMLMediaElement
}

// What close/prev/next resolve to once an unsaved-changes prompt is answered — the SAME confirm
// dialog serves all three trigger points (Escape/backdrop/X, the two pager buttons, and the in-dialog
// arrow keys), so this is the only state needed to remember which of them was actually requested.
type PendingIntent = "close" | "prev" | "next"

interface PreviewErrorBoundaryState {
	hasError: boolean
}

// The only React API for a render-phase catch (no hook equivalent). Scoped to the preview body ONLY —
// the header (Save/prev/next/download/close) lives outside it, so the overlay stays fully closeable
// even while this is showing its fallback. A synchronous viewer throw (e.g. the markdown parser, which
// runs during render, not inside an effect) would otherwise propagate past this dialog uncaught and
// white-screen the whole app — no boundary exists anywhere else in this tree. Keyed by the source key
// at its call site below (drive uuid / external url, the same key PreviewBody itself remounts on) so a
// crash on one slot can never stick once the user steps to a different one — getDerivedStateFromError has no other way back to a
// clean state.
class PreviewErrorBoundary extends Component<{ children: ReactNode }, PreviewErrorBoundaryState> {
	override state: PreviewErrorBoundaryState = { hasError: false }

	static getDerivedStateFromError(): PreviewErrorBoundaryState {
		return { hasError: true }
	}

	override componentDidCatch(error: unknown): void {
		log.error("preview", "viewer render failed", error)
	}

	override render(): ReactNode {
		return this.state.hasError ? <PreviewRenderError /> : this.props.children
	}
}

function PreviewRenderError() {
	const { t } = useTranslation("preview")

	return (
		<div className="flex size-full items-center justify-center px-6 text-center text-sm text-destructive">
			{t("previewRenderError")}
		</div>
	)
}

// Full-bleed preview surface, mounted by the drive dialog host (directoryListing.tsx) exactly like its
// sibling dialog kinds — composed directly from Base UI's dialog primitives (not the shared centered
// ui/dialog.tsx) since no full-screen surface exists yet to reuse. Closing is blocked on a pending
// state in exactly one case now: an editable text/code buffer with unsaved edits (see requestOrRun) —
// every other viewer's own data load stays a read-only, ephemeral fetch never worth protecting an
// interrupted close against.
export function PreviewOverlay({ variant, items, index, onStep, onClose, onItemRemoved }: PreviewOverlayProps) {
	const { t } = useTranslation(["preview", "common", "drive"])
	const isOnline = useIsOnline()
	const rawSource = items[index]
	// The drive item at this slot BEFORE any per-slot save override — undefined for the external arm (and
	// for an out-of-range index). The save/uuid-rotation/read-only machinery below is drive-only; the
	// external arm carries no drive item so all of it stays inert for it.
	const rawDriveItem = rawSource?.type === "drive" ? rawSource.item : undefined
	const popupRef = useRef<HTMLDivElement>(null)
	// Write-only side channel for performSave to read the live buffer without this component
	// re-rendering on every keystroke — see TextViewer's own contentRef prop doc.
	const contentRef = useRef<string | null>(null)

	// Override for the currently-displayed item, accumulated per pager slot across the whole overlay
	// session (never reset on navigation, only on remount) — `items` is a FROZEN pager snapshot that a
	// save's uuid rotation can't update in place, and a single-slot override would drop every other
	// already-saved sibling's override. Keyed by each slot's frozen pre-save `rawDriveItem.data.uuid`
	// (never the already-overridden `driveItem.data.uuid`), so a repeat save of the same slot overwrites
	// the same entry instead of chaining a new key. Drive arm only — the external arm has no save.
	const [saved, setSaved] = useState<ReadonlyMap<string, DriveItem>>(() => new Map<string, DriveItem>())
	// Single-slot (unlike `saved` above): keyed to the CURRENT pager slot only, so navigating away and
	// back can forget an earlier slot's lock (accepted — the guarded failure re-asserts on the next
	// failed save). Mirrors mobile parity's "a failed save locks the file read-only" rule; cleared by a
	// fresh item or a fresh overlay mount, never by an effect.
	const [lockedReadOnly, setLockedReadOnly] = useState<{ forUuid: string } | null>(null)
	const [dirty, setDirty] = useState(false)
	const [saving, setSaving] = useState(false)
	const [pendingIntent, setPendingIntent] = useState<PendingIntent | null>(null)
	// Which secondary dialog the header's item menu (below) currently has open, if any — a single slot
	// since only ever one item (the currently-viewed one) is ever being acted on from in here, unlike
	// useDriveDialogHost's own activeDialog which also has to carry a whole bulk-selection items[].
	// "color" is part of the shared ItemActionDialogKind union but unreachable here — driveItemActions
	// only ever offers Color for a directory, and canPreview already excludes directories from ever
	// opening this overlay in the first place.
	const [menuDialogKind, setMenuDialogKind] = useState<ItemActionDialogKind | null>(null)
	const [menuPending, setMenuPending] = useState(false)

	// Applies the per-slot save override (drive arm only) — for the external arm there is nothing to
	// override, so it passes straight through untouched.
	const driveItem = rawDriveItem !== undefined ? (saved.get(rawDriveItem.data.uuid) ?? rawDriveItem) : undefined
	// The resolved slot the body actually renders: the drive arm carries its override; the external arm is
	// its raw source. Undefined only for an out-of-range index.
	const currentSource: PreviewSource | undefined =
		rawSource === undefined
			? undefined
			: rawSource.type === "external"
				? rawSource
				: { type: "drive", item: driveItem ?? rawSource.item }
	// Editable is intrinsically drive-only: the external arm never carries an editable buffer. Compared
	// against the FROZEN pre-save uuid (rawDriveItem), never the possibly-rotated override's uuid — see
	// `saved`'s own comment on why that's the stable key.
	const editable =
		rawDriveItem !== undefined &&
		driveItem !== undefined &&
		isEditable(driveItem, variant) &&
		lockedReadOnly?.forUuid !== rawDriveItem.data.uuid

	// Header item-menu action handlers — every one below only ever runs against `driveItem`/`rawDriveItem`
	// at the CURRENT slot (the menu is only ever mounted for it, see the header JSX). Rename/favorite
	// write into the same per-slot `saved` override map performSave already uses, so the header title and
	// a reopened menu's own "Unfavorite"/"Favorite" label both reflect the change immediately, with no
	// dependency on the listing query refetching. Trash/delete/restore instead hand off to onItemRemoved
	// (the host's frozen-pager-list housekeeping) — see PreviewOverlayProps' own doc comment for why that
	// one lives on the host, not here.
	async function handleMenuRename(value: string): Promise<void> {
		if (driveItem === undefined || rawDriveItem === undefined) {
			return
		}

		setMenuPending(true)
		const outcome = await renameItem(driveItem, value.trim())
		setMenuPending(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		setSaved(prev => new Map(prev).set(rawDriveItem.data.uuid, outcome.item))
		setMenuDialogKind(null)
	}

	async function handleMenuTrash(): Promise<void> {
		if (driveItem === undefined) {
			return
		}

		setMenuPending(true)
		const outcome = await trashItems([driveItem])
		setMenuPending(false)
		setMenuDialogKind(null)
		toastBulkOutcome(outcome)

		if (outcome.succeeded.length > 0) {
			onItemRemoved()
		}
	}

	async function handleMenuDelete(): Promise<void> {
		if (driveItem === undefined) {
			return
		}

		setMenuPending(true)
		const outcome = await deleteItemsPermanently([driveItem])
		setMenuPending(false)
		setMenuDialogKind(null)
		toastBulkOutcome(outcome)

		if (outcome.succeeded.length > 0) {
			onItemRemoved()
		}
	}

	// Mirrors new mobile's removeShare/stopSharing dismissOnSuccess: isPreview === true — closes the
	// WHOLE preview immediately on success rather than stepping to a neighbour (unlike trash/delete
	// above), since new mobile's own gallery has no driveItemRemoved-driven "step past it" behavior for
	// this one.
	async function handleMenuUnshare(): Promise<void> {
		if (driveItem === undefined) {
			return
		}

		setMenuPending(true)
		const outcome = await unshareItems([driveItem], variant)
		setMenuPending(false)
		setMenuDialogKind(null)
		toastBulkOutcome(outcome)

		if (outcome.succeeded.length > 0) {
			onClose()
		}
	}

	// "favorite" descriptor's onFavoriteToggled — see itemMenu.tsx's own doc comment on why this extension
	// point exists only for the preview.
	function handleMenuFavoriteToggled(item: DriveItem): void {
		if (rawDriveItem === undefined) {
			return
		}

		setSaved(prev => new Map(prev).set(rawDriveItem.data.uuid, item))
	}

	// "restore" descriptor's onRestored (trash variant only) — a restored item leaves the trash listing
	// entirely, the same "gap in the pager" shape as trash/delete above.
	function handleMenuRestored(): void {
		onItemRemoved()
	}

	// The header item-menu's secondary dialog, if any — nested inside the outer DialogPrimitive.Root
	// exactly like the unsaved-changes ConfirmDialog below (Base UI supports nesting a dialog inside
	// another normally, see that one's own doc comment). Move/versions/info/link/share are entirely
	// self-contained dialog components (own state, own action calls) — reused completely unmodified,
	// mirroring useDriveDialogHost's identical per-kind dispatch for the row-level menu.
	function renderMenuDialog(): ReactNode {
		if (menuDialogKind === null || driveItem === undefined) {
			return null
		}

		switch (menuDialogKind) {
			case "rename":
				return (
					<InputDialog
						open
						pending={menuPending}
						title={t("drive:driveActionRename")}
						body={t("drive:driveRenameDialogBody")}
						label={t("drive:driveNewDirectoryLabel")}
						initialValue={driveItem.data.decryptedMeta?.name ?? ""}
						submitLabel={t("drive:driveActionRename")}
						validate={value => value.trim().length > 0}
						onOpenChange={open => {
							if (!open) {
								setMenuDialogKind(null)
							}
						}}
						onSubmit={value => {
							void handleMenuRename(value)
						}}
					/>
				)
			case "move":
				return (
					<MoveTargetDialog
						items={[driveItem]}
						onClose={() => {
							setMenuDialogKind(null)
						}}
					/>
				)
			case "import":
				return (
					<MoveTargetDialog
						items={[driveItem]}
						mode="import"
						onClose={() => {
							setMenuDialogKind(null)
						}}
					/>
				)
			case "versions":
				return driveItem.type === "file" ? (
					<VersionsDialog
						file={driveItem}
						onClose={() => {
							setMenuDialogKind(null)
						}}
					/>
				) : null
			case "info":
				return (
					<InfoDialog
						item={driveItem}
						remoteInfoEnabled={variant !== "trash"}
						onClose={() => {
							setMenuDialogKind(null)
						}}
					/>
				)
			case "link":
				return (
					<LinkDialog
						item={driveItem}
						onClose={() => {
							setMenuDialogKind(null)
						}}
					/>
				)
			case "share":
				return (
					<ContactPickerDialog
						items={[driveItem]}
						onClose={() => {
							setMenuDialogKind(null)
						}}
					/>
				)
			case "unshare":
				return (
					<ConfirmDialog
						open
						pending={menuPending}
						title={t("drive:driveUnshareConfirmTitle")}
						body={t("drive:driveUnshareConfirmBody", { count: 1 })}
						confirmLabel={t("drive:driveActionUnshare")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
							if (!open) {
								setMenuDialogKind(null)
							}
						}}
						onConfirm={() => {
							void handleMenuUnshare()
						}}
					/>
				)
			case "trash":
				return (
					<ConfirmDialog
						open
						pending={menuPending}
						title={t("drive:driveTrashConfirmTitle")}
						body={t("drive:driveTrashConfirmBody", { count: 1 })}
						confirmLabel={t("drive:driveActionTrash")}
						cancelLabel={t("common:cancel")}
						onOpenChange={open => {
							if (!open) {
								setMenuDialogKind(null)
							}
						}}
						onConfirm={() => {
							void handleMenuTrash()
						}}
					/>
				)
			case "delete":
				return (
					<ConfirmDialog
						open
						pending={menuPending}
						title={t("drive:driveDeletePermanentlyConfirmTitle")}
						body={t("drive:driveDeletePermanentlyConfirmBody", { count: 1 })}
						confirmLabel={t("drive:driveActionDeletePermanently")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
							if (!open) {
								setMenuDialogKind(null)
							}
						}}
						onConfirm={() => {
							void handleMenuDelete()
						}}
					/>
				)
			case "color":
				// Unreachable — see menuDialogKind's own doc comment.
				return null
		}
	}

	// A step can disable the very pager button that triggered it (index lands on the first/last item,
	// see the Prev/Next Buttons' own `disabled` below) — the browser blurs a disabled focused control
	// straight to `<body>` with no app-level recovery, which strands keyboard/AT focus OUTSIDE the
	// dialog's own DOM subtree (body is an ancestor of the portaled popup, not a descendant, so no
	// handler scoped to the popup — including handleKeyDown below — ever sees another keypress there).
	// Live-verified (page.evaluate(() => document.activeElement) read "BODY" right after such a step).
	// Pulls focus back onto the popup container itself whenever that's happened; a no-op otherwise
	// (focus already on something valid inside the dialog, e.g. the other, still-enabled pager button).
	useEffect(() => {
		if (popupRef.current && !popupRef.current.contains(document.activeElement)) {
			popupRef.current.focus()
		}
	}, [index])

	// videoContinuity.ts's position map is scoped to exactly one overlay SESSION — this component itself
	// only ever mounts while a preview is open (useDriveDialogHost's conditional render), so its own
	// unmount is precisely "the overlay closed"; clearing here (rather than in onClose, which the header
	// item-menu's own Trash/Unshare success paths also call, all funneling through the SAME close) keeps
	// this a single, unconditional cleanup with no risk of missing a dismissal route.
	useEffect(() => {
		return () => {
			clearVideoPlaybackStates()
		}
	}, [])

	// The one write path: encode -> upload -> patch listing -> re-key onto the rotated uuid (success), or
	// a LABEL-FIRST toast (failure) — read-only lockdown is reserved for the ONE failure class retrying
	// can never fix (isUnresolvableParentError, see previewSave.logic.ts's own comment on why); every
	// other failure leaves the buffer editable+dirty for a retry. `dirty` resets for free on SUCCESS
	// only: a new `item.data.uuid` re-keys PreviewBody, remounting TextViewer fresh with its own clean
	// `dirty=false` (see textViewer.tsx's own mount-time effect) — a FAILURE never remounts anything, so
	// the buffer (and its dirty bit) simply survives untouched, which is exactly what keeps the typed
	// content visible and the close/nav prompt still armed either way.
	async function performSave(): Promise<void> {
		// Locals, not the outer `driveItem`/`rawDriveItem` directly — this closure runs asynchronously, well
		// after this render's narrowing; re-binding here gives the guard below its own, freshly-narrowable copy.
		const targetItem = driveItem
		const targetRawItem = rawDriveItem

		if (!editable || !dirty || saving || targetItem === undefined || targetRawItem === undefined) {
			return
		}

		const content = contentRef.current

		if (content === null) {
			return
		}

		setSaving(true)

		const outcome = await runPreviewSave(
			{
				uploadFileBytes: (parentUuid, data, name, mime) => sdkApi.uploadFileBytes(parentUuid, data, name, mime),
				patchListing: driveListingQueryUpdate,
				rootUuid: currentRootUuid()
			},
			{ item: targetItem, content }
		)

		setSaving(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))

			if (isUnresolvableParentError(outcome.dto)) {
				setLockedReadOnly({ forUuid: targetRawItem.data.uuid })
				toast.warning(t("previewReadOnlyAfterSaveFailure"))
			}

			return
		}

		// Keyed by the FROZEN slot uuid (targetRawItem), never targetItem's own uuid — see `saved`'s own
		// comment on why that's what makes a chained re-save of the same slot collapse onto one entry.
		setSaved(prev => new Map(prev).set(targetRawItem.data.uuid, outcome.item))
	}

	useAction(
		"preview.save",
		keyboardEvent => {
			// Unconditional, mirroring drive.download's own mod+s handler — the browser's native
			// Save-Page-As must never fire here regardless of whether a save is actually possible right now.
			keyboardEvent.preventDefault()
			void performSave()
		},
		{ enableOnContentEditable: true },
		[editable, dirty, saving, driveItem, rawDriveItem]
	)

	// Routes a close/prev/next intent through the unsaved-changes prompt whenever the buffer is dirty;
	// runs it immediately otherwise. Every dismissal route (Escape, backdrop, the X button — all three
	// fold into Base UI's own onOpenChange(false)), both pager buttons, and the in-dialog arrow keys
	// funnel through this, so none of them can silently drop an in-progress edit. Gated on `dirty` ALONE,
	// not `editable && dirty`: a failed save can lock the buffer read-only (setLockedReadOnly above)
	// without ever clearing `dirty` — the user's unsaved edits are still sitting there, about to be lost,
	// so the prompt must still fire even though no further edit (or save) is possible anymore. An
	// in-flight save blocks the intent outright (mirrors the pager buttons' own disabled state):
	// prompting "discard?" mid-save would let the user discard while the un-cancellable upload still
	// lands and patches the listing — a silent contradiction of the choice they just made.
	function requestOrRun(intent: PendingIntent, run: () => void): void {
		if (saving) {
			return
		}

		if (dirty) {
			setPendingIntent(intent)
			return
		}

		run()
	}

	function handleOpenChange(next: boolean): void {
		if (!next) {
			requestOrRun("close", onClose)
		}
	}

	// Base UI's DialogPopup calls event.stopPropagation() for every composite key (Arrow*/Home/End) in
	// its own onKeyDown (dialog/popup/DialogPopup.js + internals/composite/composite.js's
	// COMPOSITE_KEYS, verified against the installed package) before it can bubble to the document-level
	// keymap listener useAction/react-hotkeys-hook registers — so ArrowLeft/ArrowRight can never reach a
	// global drive.previewPrev/drive.previewNext action while the dialog holds focus. Merged onKeyDown
	// props run right-to-left (merge-props.js), so a handler passed directly on Popup (below) still runs
	// BEFORE that internal stopPropagation — this is that handler, mirroring moveTargetDialog.tsx's own
	// local onKeyDown for the identical in-dialog-focus-trap reason.
	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
		// A focused media scrubber wins over the pager — native seek expectation (see isMediaTarget
		// above). A focused CodeMirror surface wins too — its own arrow bindings move the cursor/
		// selection and never stopPropagation, so without this a Left/Right meant for the caret would
		// also page the overlay (or pop the unsaved-changes prompt on every press) — see
		// previewOverlay.logic.ts's own isTextEditingTarget for why this checks read-only CodeMirror
		// too, not just the editable case.
		if (isMediaTarget(event.target) || isTextEditingTarget(event.target)) {
			return
		}

		if (event.key === "ArrowLeft") {
			event.preventDefault()
			requestOrRun("prev", () => {
				onStep(-1)
			})
		} else if (event.key === "ArrowRight") {
			event.preventDefault()
			requestOrRun("next", () => {
				onStep(1)
			})
		}
	}

	function handleUnsavedConfirm(): void {
		const intent = pendingIntent
		setPendingIntent(null)

		if (intent === "close") {
			onClose()
		} else if (intent === "prev") {
			onStep(-1)
		} else if (intent === "next") {
			onStep(1)
		}
	}

	if (currentSource === undefined) {
		return null
	}

	const name = previewSourceName(currentSource)

	return (
		<DialogPrimitive.Root
			open
			onOpenChange={handleOpenChange}
		>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-background duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
				<DialogPrimitive.Popup
					ref={popupRef}
					onKeyDown={handleKeyDown}
					className="fixed inset-0 z-50 flex flex-col bg-background duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
				>
					<header className="flex h-14 shrink-0 items-center gap-1 px-4">
						<PreviewName name={name} />
						{editable && dirty ? (
							<Button
								variant="ghost"
								size="icon-sm"
								disabled={saving}
								aria-label={t("previewSaveAction")}
								onClick={() => {
									void performSave()
								}}
							>
								{saving ? <Spinner className="size-4" /> : <SaveIcon />}
							</Button>
						) : null}
						<Button
							variant="ghost"
							size="icon-sm"
							disabled={index <= 0 || saving}
							aria-label={t("previewPreviousAction")}
							onClick={() => {
								requestOrRun("prev", () => {
									onStep(-1)
								})
							}}
						>
							<ChevronLeftIcon />
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							disabled={index >= items.length - 1 || saving}
							aria-label={t("previewNextAction")}
							onClick={() => {
								requestOrRun("next", () => {
									onStep(1)
								})
							}}
						>
							<ChevronRightIcon />
						</Button>
						{currentSource.type === "drive" && variant !== "trash" ? (
							<Button
								variant="ghost"
								size="icon-sm"
								disabled={!isOnline}
								aria-label={t("previewDownloadAction")}
								title={!isOnline ? t("common:offlineActionDisabled") : undefined}
								onClick={() => {
									void startDownloads([currentSource.item])
								}}
							>
								<DownloadIcon />
							</Button>
						) : null}
						{/* Drive-sourced items only — the external arm (chat/note attachments) has no drive item
						for driveItemActions to gate against, so it shows no menu at all, same as the tile/row
						faces' own ⋯ trigger. Same descriptor list + dropdown renderer those use (itemMenu.tsx),
						just with "download" hidden (the button above already covers it) and the two extra
						"direct"-outcome hooks wired into this overlay's own per-slot `saved` override / pager
						housekeeping — see PREVIEW_MENU_HIDDEN_ACTION_IDS and the handleMenu* functions above. */}
						{previewMenuVisible(currentSource) && driveItem !== undefined ? (
							<DropdownMenu>
								<DropdownMenuTrigger
									render={
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label={t("drive:driveItemMenuTrigger")}
										>
											<MoreHorizontalIcon />
										</Button>
									}
								/>
								<DriveDropdownMenuContent
									item={driveItem}
									variant={variant}
									onItemAction={kind => {
										setMenuDialogKind(kind)
									}}
									onFavoriteToggled={handleMenuFavoriteToggled}
									onRestored={handleMenuRestored}
									hiddenActionIds={PREVIEW_MENU_HIDDEN_ACTION_IDS}
								/>
							</DropdownMenu>
						) : null}
						<DialogPrimitive.Close
							render={
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={t("common:close")}
								/>
							}
						>
							<XIcon />
						</DialogPrimitive.Close>
					</header>
					<div className="min-h-0 flex-1">
						<PreviewErrorBoundary key={previewSourceKey(currentSource)}>
							<PreviewBody
								source={currentSource}
								editable={editable}
								onDirtyChange={setDirty}
								contentRef={contentRef}
							/>
						</PreviewErrorBoundary>
					</div>
					{/* Nested confirmation dialog — Base UI supports nesting a dialog inside another normally
					(see versionsDialog.tsx's own identical precedent); this must stay a child of the outer
					Dialog, not a sibling rendered outside it, for the stacked focus-trap/backdrop behavior to
					apply. Shared by close/prev/next — see PendingIntent — rather than one instance per trigger. */}
					<ConfirmDialog
						open={pendingIntent !== null}
						pending={false}
						title={t("previewUnsavedChangesTitle")}
						body={t("previewUnsavedChangesBody")}
						confirmLabel={t("previewDiscardAction")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
							if (!open) {
								setPendingIntent(null)
							}
						}}
						onConfirm={handleUnsavedConfirm}
					/>
					{/* The header item-menu's own secondary dialog (rename/move/trash/etc.) — same nesting
					precedent as the unsaved-changes ConfirmDialog above. */}
					{renderMenuDialog()}
				</DialogPrimitive.Popup>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	)
}

// Middle-ish ellipsis for a long filename: the head truncates with a CSS ellipsis while the tail
// (typically the extension) always stays visible, rather than the browser's default end-truncation
// swallowing it. Also carries the dialog's required accessible title.
function PreviewName({ name }: { name: string }) {
	const TAIL_LENGTH = 16
	const splitAt = name.length - TAIL_LENGTH

	return (
		<DialogPrimitive.Title className="flex min-w-0 flex-1 font-heading text-sm font-medium">
			{splitAt > 0 ? (
				<>
					<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{name.slice(0, splitAt)}</span>
					<span className="shrink-0 whitespace-nowrap">{name.slice(splitAt)}</span>
				</>
			) : (
				<span className="truncate">{name}</span>
			)}
		</DialogPrimitive.Title>
	)
}

interface PreviewBodyProps {
	source: PreviewSource
	editable: boolean
	onDirtyChange: (dirty: boolean) => void
	contentRef: RefObject<string | null>
}

// The external arm's body — a bare url with no drive item, so no SW range route, byte-buffering, HEIC
// transform, editability or save exists for it (external urls load natively in the browser). Renders
// only the url-loadable kinds through the media viewers' own plain-url render paths (ZoomableImage /
// MediaElement); everything else shows the standard unsupported state. This is the minimal-but-real
// seam for future chat/note attachment sources.
function ExternalPreviewBody({ url, name }: { url: string; name: string }) {
	const { t } = useTranslation("preview")
	const category = previewCategoryForName(name)

	switch (category) {
		case "image":
			return (
				<ZoomableImage
					url={url}
					alt={name}
				/>
			)
		case "video":
		case "audio":
			return (
				<MediaElement
					category={category}
					url={url}
					alt={name}
				/>
			)
		default:
			return (
				<div className="flex size-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
					{t("previewUnsupportedType")}
				</div>
			)
	}
}

// Dispatches to the right viewer by category — remounted (keyed by uuid, see the error boundary one
// level up) on every item change so a viewer's own pending/success/error state never flashes the
// previous item's content. Bytes are no longer loaded centrally here: image/video/audio each own their
// own data source (a streamed SW URL or a buffered blob, see imageViewer.tsx/mediaViewer.tsx),
// pdf/docx each own a lazy chunk plus their own whole-buffer load (see pdfViewer.tsx/docxViewer.tsx)
// — a category still rendered by the fallback below (text/code/markdown) has nothing to load yet.
// `editable`/`onDirtyChange`/`contentRef` only ever reach TextViewer (the "text"/"code" case) — every
// other category ignores them.
function PreviewBody({ source, editable, onDirtyChange, contentRef }: PreviewBodyProps) {
	const { t } = useTranslation("preview")

	if (source.type === "external") {
		return (
			<ExternalPreviewBody
				url={source.url}
				name={source.name}
			/>
		)
	}

	const item = source.item

	// Narrows `data.decryptedMeta` to the file-arm's DecryptedFileMeta (which alone carries `.mime`) —
	// previewType/canPreview already guarantee a file arm for every item that ever reaches this
	// component, but that guarantee lives in a plain function's return value, not a type predicate, so
	// TS needs this explicit narrow before a `.mime`/`.name` access type-checks.
	const base = asDirectoryOrFile(item)

	if (base.type !== "file") {
		return null
	}

	const alt = base.data.decryptedMeta?.name ?? base.data.uuid
	// Stored once (rather than switching on the previewType(item) call directly) so the "video"/"audio"
	// case below can pass it straight through as MediaViewer's own narrower category prop without a
	// second, redundant resolution — a raw switch on the call expression doesn't narrow across cases.
	const category = previewType(item)

	switch (category) {
		case "image":
			return (
				<ImageViewer
					item={item}
					alt={alt}
				/>
			)
		case "video":
		case "audio":
			return (
				<MediaViewer
					item={item}
					category={category}
					alt={alt}
				/>
			)
		case "pdf":
			return (
				<Suspense
					fallback={
						<div className="flex size-full items-center justify-center">
							<Spinner className="size-6" />
						</div>
					}
				>
					<PdfViewer
						item={item}
						alt={alt}
					/>
				</Suspense>
			)
		case "docx":
			return (
				<Suspense
					fallback={
						<div className="flex size-full items-center justify-center">
							<Spinner className="size-6" />
						</div>
					}
				>
					<DocxViewer
						item={item}
						alt={alt}
					/>
				</Suspense>
			)
		case "text":
		case "code":
			return (
				<Suspense
					fallback={
						<div className="flex size-full items-center justify-center">
							<Spinner className="size-6" />
						</div>
					}
				>
					<TextViewer
						item={item}
						alt={alt}
						editable={editable}
						onDirtyChange={onDirtyChange}
						contentRef={contentRef}
					/>
				</Suspense>
			)
		case "markdown":
			return (
				<Suspense
					fallback={
						<div className="flex size-full items-center justify-center">
							<Spinner className="size-6" />
						</div>
					}
				>
					<MarkdownViewer
						item={item}
						alt={alt}
					/>
				</Suspense>
			)
		// No viewer exists for "other" — canPreview already excludes it from ever reaching the overlay
		// at all (it's unreachable here in practice), kept as the exhaustive switch's required fallback.
		case "other":
			return (
				<div className="flex size-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
					{t("previewUnsupportedType")}
				</div>
			)
	}
}
