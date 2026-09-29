import {
	useEffect,
	useRef,
	useState,
	lazy,
	Suspense,
	Component,
	type FocusEvent as ReactFocusEvent,
	type KeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	type RefObject
} from "react"
import { useTranslation } from "react-i18next"
import { useBlocker, type ShouldBlockFn } from "@tanstack/react-router"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { XIcon, ChevronLeftIcon, ChevronRightIcon, DownloadIcon, SaveIcon, MoreHorizontalIcon } from "lucide-react"
import { toast } from "sonner"
import { asDirectoryOrFile, isLinkedEmbedItem, type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { extensionOf, previewType, type PreviewCategory } from "@/features/drive/lib/preview.logic"
import { startDownloads } from "@/features/drive/lib/download"
import {
	canSaveCopyBeside,
	isEditable,
	isTextCategory,
	isUnresolvableParentError,
	runPreviewSave
} from "@/features/drive/lib/previewSave.logic"
import { currentRootUuid, renameItem, trashItems, deleteItemsPermanently } from "@/features/drive/lib/actions"
import { followClipboardItem } from "@/features/drive/lib/clipboardSync"
import { unshareItems } from "@/features/drive/lib/share/actions"
import { driveListingQueryUpdate } from "@/features/drive/queries/drive"
import { toastBulkOutcome } from "@/features/drive/lib/bulkToast"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { sdkApi } from "@/lib/sdk/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { IN_EDITORS_AND_FIELDS, useAction } from "@/lib/keymap/useAction"
import { log } from "@/lib/log"
import { useIsOnline } from "@/lib/useIsOnline"
import { holdUnload } from "@/lib/unloadGuard"
import { previewTitleSplitIndex } from "@/features/preview/lib/previewTitle"
import { cn, driveItemName } from "@filen/shared"
import { ImageViewer, RawImageViewer } from "@/features/preview/components/imageViewer"
import { MediaViewer } from "@/features/preview/components/mediaViewer"
import { PreviewDownloadableProvider } from "@/features/preview/lib/accessMode"
import {
	isTextEditingTarget,
	PREVIEW_SURFACE,
	previewNavigationUnmountsOverlay,
	previewMenuHiddenActionIds,
	hasClosest,
	isVideoControlsBandClick,
	resolveUnsavedConfirm,
	shouldToggleChrome,
	unsavedPromptOpen,
	type PreviewDismissIntent
} from "@/features/preview/components/previewOverlay.logic"
import { setPreviewDirty, usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"
import { clearVideoPlaybackStates } from "@/features/preview/lib/videoContinuity"
import { clearPreviewCache, loadPreviewBytes } from "@/features/preview/lib/previewCache"
import { usePreviewCacheScope } from "@/features/preview/lib/accessMode"
import type { SpreadsheetSaveSource } from "@/features/spreadsheet/components/spreadsheetViewer"
import { spreadsheetSaveFormat } from "@/features/spreadsheet/lib/spreadsheetClient"
import { usePreviewRemoteChanges } from "@/features/preview/hooks/usePreviewRemoteChanges"
import { RemoteChangeDialog } from "@/features/preview/components/remoteChangeDialog"
import { DriveDropdownMenuContent } from "@/features/drive/components/itemMenu"
import { type ItemActionDialogKind, type ItemActionId } from "@/features/drive/components/itemMenu.logic"
import { MoveTargetDialog } from "@/features/drive/components/moveTargetDialog"
import { InfoDialog } from "@/features/drive/components/infoDialog"
import { LinkDialog } from "@/features/drive/components/linkDialog"
import { ContactPickerDialog } from "@/features/drive/components/contactPickerDialog"
import { VersionsDialog } from "@/features/drive/components/versionsDialog"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Kbd } from "@/lib/keymap/kbd"
import { Spinner } from "@/components/ui/spinner"
import { LoadingState } from "@/components/loadingState"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { isAnyMenuOpen } from "@/lib/keymap/dialogGuard"

// Lazy chunks: pdf.js (~1MB+), docx-preview, CodeMirror (+ its per-language grammar chunks) and
// react-markdown only ever download once a file needing them is actually opened, never on the app's
// own initial bundle (image/video/audio all stream or buffer directly, no heavy renderer library
// involved). markdownViewer.tsx's own "view source" toggle lazy-imports CodeMirrorSource — the module
// TextViewer's chunk also pulls in, deduped by the bundler.
const PdfViewer = lazy(() => import("@/features/preview/components/pdfViewer"))
const DocxViewer = lazy(() => import("@/features/preview/components/docxViewer"))
const TextViewer = lazy(() => import("@/features/preview/components/textViewer"))
const MarkdownViewer = lazy(() => import("@/features/preview/components/markdownViewer"))
const SpreadsheetViewer = lazy(() => import("@/features/spreadsheet/components/spreadsheetViewer"))
// @codemirror/merge, for the remote-change dialog's comparison only.
const RemoteFileCompare = lazy(() => import("@/features/preview/components/remoteCompare"))

// Module scope, not an inline arrow: useBlocker's registration effect lists shouldBlockFn in its own
// deps, so a per-render identity would unregister/re-register the history blocker on every render.
const blockWhenLeavingRoute: ShouldBlockFn = ({ current, next }) => previewNavigationUnmountsOverlay(current.routeId, next.routeId)

export interface PreviewOverlayProps {
	variant: DriveVariant
	// Frozen previewable-sibling snapshot taken at open time (directoryListing.tsx's handleOpen) — the
	// pager's whole candidate list, not just the opened item.
	items: DriveItem[]
	index: number
	onStep: (delta: 1 | -1) => void
	onClose: () => void
	// Trash/delete-permanently/restore-from-trash on the CURRENTLY VIEWED item, run from the header's own
	// item menu below — the host owns the frozen pager list, so it (not this component) drops the slot
	// and either steps to a neighbour or closes outright once none remain (useDriveDialogHost's
	// removeCurrentPreviewItem, mirroring new mobile's driveItemRemoved gallery subscriber). Carries the
	// slot's FROZEN uuid so the host removes by identity, never by index: the socket echo of this same
	// mutation also removes the slot (uuid-keyed), and whichever arrives second must no-op — an
	// index-keyed removal racing the echo would drop the NEIGHBOUR instead and collapse the pager.
	// Unshare uses the plain `onClose` above instead — new mobile dismisses the whole preview immediately
	// for that one rather than stepping to a neighbour (menuActions.ts's dismissOnSuccess: isPreview).
	onItemRemoved: (frozenUuid: string) => void
	// Optional host-level extension point for the header menu's favorite toggle, ON TOP OF this
	// component's own per-slot `saved` override (which only keeps the OPEN pager's title/menu-label in
	// sync, never any listing cache). The drive host omits this: toggleFavorite already patches every
	// `["drive", "listing", …]` key itself (features/drive/lib/actions.ts's applyFavoritePatch), so a
	// drive-opened overlay needs nothing further. A photos-opened overlay does: the photos listing lives
	// under its own `["photos", …]` key that patch never reaches, and otherwise only the realtime
	// `itemFavorite` echo (photos queries' patchPhotosFavorite) would reflect the toggle back into the
	// grid, a socket round trip later.
	onFavoriteToggled?: (item: DriveItem) => void
	// Header-menu entries the opening surface doesn't offer in its own menus, so the viewer matches them
	// (Photos hides Move).
	hiddenMenuActionIds?: ReadonlySet<ItemActionId> | undefined
	// False for a public link's file whose owner disallows downloads: nothing here offers to save it.
	// Downloadable when omitted.
	downloadable?: boolean
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

interface PreviewErrorBoundaryState {
	hasError: boolean
}

// The only React API for a render-phase catch (no hook equivalent). Scoped to the preview body ONLY —
// the header (Save/prev/next/download/close) lives outside it, so the overlay stays fully closeable
// even while this is showing its fallback. A synchronous viewer throw (e.g. the markdown parser, which
// runs during render, not inside an effect) would otherwise propagate past this dialog uncaught and
// white-screen the whole app — no boundary exists anywhere else in this tree. Keyed by bodyKey
// at its call site below (the drive uuid, the same key PreviewBody itself remounts on) so a
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
export function PreviewOverlay({
	variant,
	items,
	index,
	onStep,
	onClose,
	onItemRemoved,
	onFavoriteToggled,
	hiddenMenuActionIds,
	downloadable: downloadableProp
}: PreviewOverlayProps) {
	// Not a parameter default: the React Compiler skips a component that has one.
	const downloadable = downloadableProp !== false
	const { t } = useTranslation(["preview", "common", "drive"])
	const isOnline = useIsOnline()
	// The drive item at this slot BEFORE any per-slot save override — undefined only for an out-of-range
	// index.
	const rawDriveItem = items[index]
	const popupRef = useRef<HTMLDivElement>(null)
	// Reader for performSave to pull the live buffer without this component
	// re-rendering on every keystroke — see TextViewer's own contentRef prop doc.
	const contentRef = useRef<(() => string) | null>(null)
	// The spreadsheet editor's side channel: its bytes as edited, serialised when a save asks for them.
	const spreadsheetRef = useRef<SpreadsheetSaveSource | null>(null)
	const cacheScope = usePreviewCacheScope()

	// The open editor's unsaved edits, encoded.
	async function readEdits(): Promise<Uint8Array | null> {
		return (await readSaveEdits())?.bytes ?? null
	}

	// Override for the currently-displayed item, accumulated per pager slot across the whole overlay
	// session (never reset on navigation, only on remount) — `items` is a FROZEN pager snapshot that a
	// save's uuid rotation can't update in place, and a single-slot override would drop every other
	// already-saved sibling's override. Keyed by each slot's frozen pre-save `rawDriveItem.data.uuid`
	// (never the already-overridden `driveItem.data.uuid`), so a repeat save of the same slot overwrites
	// the same entry instead of chaining a new key.
	const [saved, setSaved] = useState<ReadonlyMap<string, DriveItem>>(() => new Map<string, DriveItem>())
	// The same map for code running outside a render (the remote-change handlers), which may apply two
	// overrides before the next render. Every write goes through commitSaved, keeping the two equal.
	const savedRef = useRef(saved)
	// Per slot (frozen uuid), which content its spreadsheet grid holds: unchanged by the user's own saves,
	// which rotate the uuid but leave the grid (sheet, scroll, undo) as it is, and new for any other
	// version shown (one saved elsewhere, a restore). Absent until then: the frozen uuid itself.
	const [documentKeys, setDocumentKeys] = useState<ReadonlyMap<string, string>>(() => new Map<string, string>())
	const documentKeysRef = useRef(documentKeys)
	const documentGeneration = useRef(0)
	// The slot on screen's pinned renderer and save format (slotPin), and the document it was taken for.
	const [pinned, setPinned] = useState<{ documentKey: string; pin: SlotPin } | null>(null)
	// Single-slot (unlike `saved` above): keyed to the CURRENT pager slot only, so navigating away and
	// back can forget an earlier slot's lock (accepted — the guarded failure re-asserts on the next
	// failed save). Mirrors mobile parity's "a failed save locks the file read-only" rule; cleared by a
	// fresh item or a fresh overlay mount, never by an effect.
	const [lockedReadOnly, setLockedReadOnly] = useState<{ forUuid: string } | null>(null)
	// Not component state: the sign-out path is a plain lib function and has to be able to read this
	// same bit (see usePreviewUnsavedGuard). Boolean-collapsed selector, so the overlay still re-renders
	// on the dirty EDGE only.
	const dirty = usePreviewUnsavedGuardStore(state => state.dirty)
	const logoutRequest = usePreviewUnsavedGuardStore(state => state.logoutRequest)
	const [saving, setSaving] = useState(false)
	const [pendingIntent, setPendingIntent] = useState<PreviewDismissIntent | null>(null)
	// Which secondary dialog the header's item menu (below) currently has open, if any — a single slot
	// since only ever one item (the currently-viewed one) is ever being acted on from in here, unlike
	// useDriveDialogHost's own activeDialog which also has to carry a whole bulk-selection items[].
	// "color" is part of the shared ItemActionDialogKind union but unreachable here — driveItemActions
	// only ever offers Color for a directory, and canPreview already excludes directories from ever
	// opening this overlay in the first place.
	const [menuDialogKind, setMenuDialogKind] = useState<ItemActionDialogKind | null>(null)
	const [menuPending, setMenuPending] = useState(false)
	// Click-to-hide-chrome: clicking the media surface itself (not a button/scrubber/pager control,
	// see shouldToggleChrome) toggles the header — the pager's prev/next buttons live inside it too, so
	// there is no separate floating control to hide. Reset to visible on every pager step (below) and on
	// any close/dismiss attempt (handleOpenChange), never left hidden across either.
	const [chromeVisible, setChromeVisible] = useState(true)
	// "Adjusting state during render" (React's own documented alternative to an effect for this exact
	// shape, react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes) —
	// react-hooks/set-state-in-effect forbids the more obvious `useEffect(() => setChromeVisible(true),
	// [index])` (a synchronous setState in an effect body), and this form also avoids that extra
	// render+effect round trip: the reset lands in the SAME render that already picked up the new index.
	const [chromeResetForIndex, setChromeResetForIndex] = useState(index)

	if (chromeResetForIndex !== index) {
		setChromeResetForIndex(index)
		setChromeVisible(true)
	}

	// The resolved slot the body actually renders, carrying its per-slot save override. Undefined only for
	// an out-of-range index.
	const driveItem = rawDriveItem !== undefined ? (saved.get(rawDriveItem.data.uuid) ?? rawDriveItem) : undefined
	const currentDocumentKey = rawDriveItem === undefined ? "" : (documentKeys.get(rawDriveItem.data.uuid) ?? rawDriveItem.data.uuid)
	// The drive slot's renderer and save format, as it mounted: a rename never swaps the viewer (and with it
	// the unsaved edits) out from under the user. Taken again whenever the slot mounts anew, which is only
	// ever clean (stepping to it, or a new document, see documentKeys): its name as it stands then decides.
	const derivedPin = driveItem === undefined ? null : slotPin(driveItem, variant)
	const pin = derivedPin === null ? null : pinned?.documentKey === currentDocumentKey ? pinned.pin : derivedPin

	if (derivedPin !== null && pinned?.documentKey !== currentDocumentKey) {
		setPinned({ documentKey: currentDocumentKey, pin: derivedPin })
	}

	// Compared against the FROZEN pre-save uuid (rawDriveItem), never the possibly-rotated override's uuid — see
	// `saved`'s own comment on why that's the stable key. A rename to another format leaves the open
	// viewer read-only: what it holds would be saved under a name that says otherwise.
	const editable =
		rawDriveItem !== undefined &&
		driveItem !== undefined &&
		pin !== null &&
		isEditable(driveItem, variant) &&
		saveFormat(driveItem) === pin.format &&
		lockedReadOnly?.forUuid !== rawDriveItem.data.uuid
	// Read-only only because a rename changed the format the open edits would be saved in.
	const renamedReadOnly = driveItem !== undefined && pin?.editable === true && saveFormat(driveItem) !== pin.format

	// `ownSave`: `item` is what this overlay's own save of the slot made.
	function commitSaved(frozenUuid: string, item: DriveItem, ownSave?: boolean): void {
		const shownUuid = savedRef.current.get(frozenUuid)?.data.uuid ?? frozenUuid

		if (ownSave !== true && item.data.uuid !== shownUuid) {
			documentGeneration.current++

			const keys = new Map(documentKeysRef.current).set(frozenUuid, `${frozenUuid}:${String(documentGeneration.current)}`)

			documentKeysRef.current = keys
			setDocumentKeys(keys)
		}

		const next = new Map(savedRef.current).set(frozenUuid, item)

		savedRef.current = next
		setSaved(next)
	}

	// Newer versions of the pager's files saved elsewhere, and a trash, delete or move of the file on
	// screen while it holds unsaved edits: shown in place, or asked about (RemoteChangeDialog below).
	const remote = usePreviewRemoteChanges({ variant, items, index, savedRef, commitSaved, contentRef, readEdits, onItemRemoved })

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

		commitSaved(rawDriveItem.data.uuid, outcome.item)
		setMenuDialogKind(null)
	}

	async function handleMenuTrash(): Promise<void> {
		if (driveItem === undefined || rawDriveItem === undefined) {
			return
		}

		setMenuPending(true)
		// Its echo can beat the response back: the user's own trash, not one made elsewhere.
		remote.expectOwnChange(driveItem.data.uuid, "remove")
		const outcome = await trashItems([driveItem])
		remote.forgetOwnChange(driveItem.data.uuid)
		setMenuPending(false)
		setMenuDialogKind(null)
		toastBulkOutcome(outcome)

		if (outcome.succeeded.length > 0) {
			onItemRemoved(rawDriveItem.data.uuid)
		}
	}

	async function handleMenuDelete(): Promise<void> {
		if (driveItem === undefined || rawDriveItem === undefined) {
			return
		}

		setMenuPending(true)
		remote.expectOwnChange(driveItem.data.uuid, "remove")
		const outcome = await deleteItemsPermanently([driveItem])
		remote.forgetOwnChange(driveItem.data.uuid)
		setMenuPending(false)
		setMenuDialogKind(null)
		toastBulkOutcome(outcome)

		if (outcome.succeeded.length > 0) {
			onItemRemoved(rawDriveItem.data.uuid)
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
			// Only this receiver's row leaves the listing, and no echo prunes a selected row the way
			// trash and delete echoes do.
			useDriveStore.getState().removeRowsFromSelection(outcome.succeeded)
			onClose()
		}
	}

	// "favorite" descriptor's onFavoriteToggled — see itemMenu.tsx's own doc comment on why this extension
	// point exists only for the preview. Fans out to the optional host-level callback too — see
	// PreviewOverlayProps' own doc comment on onFavoriteToggled for why a photos-opened overlay needs it
	// and a drive-opened one doesn't.
	function handleMenuFavoriteToggled(item: DriveItem): void {
		if (rawDriveItem === undefined) {
			return
		}

		commitSaved(rawDriveItem.data.uuid, item)
		onFavoriteToggled?.(item)
	}

	// "restore" descriptor's onRestored (trash variant only) — a restored item leaves the trash listing
	// entirely, the same "gap in the pager" shape as trash/delete above.
	function handleMenuRestored(): void {
		if (rawDriveItem === undefined) {
			return
		}

		onItemRemoved(rawDriveItem.data.uuid)
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
			case "copy":
				return (
					<MoveTargetDialog
						items={[driveItem]}
						mode="copy"
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
						variant={variant}
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
	// this a single, unconditional cleanup with no risk of missing a dismissal route. The preview
	// byte cache is scoped the same way, so a closed overlay stops holding file buffers.
	useEffect(() => {
		return () => {
			clearVideoPlaybackStates()
			clearPreviewCache()
		}
	}, [])

	// The prompt that answers a waiting sign-out lives BELOW the `driveItem === undefined` early
	// return, so a slot that vanished under a dirty editor (its item removed elsewhere) must drop the
	// guard too — otherwise a sign-out would wait forever on a dialog that can never render. Store
	// writes, not React setState, so react-hooks/set-state-in-effect does not apply.
	const slotVanished = driveItem === undefined

	useEffect(() => {
		if (slotVanished) {
			usePreviewUnsavedGuardStore.getState().clear()
		}
	}, [slotVanished])

	// A dirty buffer belongs to exactly ONE slot, and every slot change remounts PreviewBody (keyed by
	// this same value), so whatever editor mounts next re-seeds and reports its own bit. The gap this
	// closes is a slot REMOVED under a dirty editor — trashed/deleted from the header menu below, or
	// removed on another device and reconciled away by the host: the pager lands on a neighbour with the
	// overlay still mounted, so neither the unmount cleanup nor the vanished-slot effect above runs, and a
	// neighbour that mounts no editor at all (an image, a PDF, a rendered markdown) would strand the flag
	// on a buffer that no longer exists — a prompt about nothing, an armed route block and beforeunload.
	const slotKey = driveItem === undefined ? null : bodyKey(driveItem, currentDocumentKey, pin)

	useEffect(() => {
		setPreviewDirty(false)
		contentRef.current = null
	}, [slotKey])

	useEffect(() => {
		return () => {
			usePreviewUnsavedGuardStore.getState().clear()
		}
	}, [])

	// Browser-level guard for the two vectors the in-app requestOrRun path cannot see: a tab
	// refresh/close (the app's one leave-page listener, which excuses its own downloads — the router's
	// would prompt on them) and any navigation that unmounts this overlay's route body. Armed ONLY while
	// the buffer is dirty AND a slot is actually rendered: without the second term a vanished slot (early
	// return below → no ConfirmDialog in the tree) could block a navigation nothing can then resolve,
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

	// The one write path: encode -> upload -> patch listing -> re-key onto the rotated uuid (success), or
	// a LABEL-FIRST toast (failure) — read-only lockdown is reserved for the ONE failure class retrying
	// can never fix (isUnresolvableParentError, see previewSave.logic.ts's own comment on why); every
	// other failure leaves the buffer editable+dirty for a retry. `dirty` is reset explicitly on SUCCESS
	// below — a new `item.data.uuid` re-keys PreviewBody and the remounted viewer re-seeds a fresh
	// editor's own buffer, but a slot that mounts NO editor (markdown returns in rendered mode) would
	// otherwise never report the buffer clean. A FAILURE never remounts anything, so the buffer (and its
	// dirty bit) simply survives untouched, which is what keeps the typed content visible and the
	// close/nav prompt still armed.
	async function performSave(): Promise<void> {
		// Locals, not the outer `driveItem`/`rawDriveItem` directly — this closure runs asynchronously, well
		// after this render's narrowing; re-binding here gives the guard below its own, freshly-narrowable copy.
		const targetItem = driveItem
		const targetRawItem = rawDriveItem

		// Nor under a dialog: over the remote-change question it would decide it for the user, and a save
		// from the unsaved-changes prompt or a menu dialog would act behind it.
		if (
			!editable ||
			!dirty ||
			saving ||
			targetItem === undefined ||
			targetRawItem === undefined ||
			remote.prompt !== null ||
			unsavedPromptOpen(pendingIntent, blocker.status === "blocked", logoutRequest !== null) ||
			menuDialogKind !== null
		) {
			return
		}

		setSaving(true)
		remote.saveStarted()

		const edits = await readSaveEdits().catch((e: unknown) => {
			log.error("preview", "reading the edits to save failed", e)

			return null
		})

		if (edits === null) {
			setSaving(false)
			remote.saveSettled(null)
			toast.error(t("previewSaveFailed"))

			return
		}

		const content = edits.bytes
		// The upload hands the buffer to the SDK worker; the copy seeds the saved version's preview, so the
		// editor reopens on it without downloading what it just sent.
		const saved = content.slice()

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
			remote.saveSettled(null)

			if (isUnresolvableParentError(outcome.dto)) {
				setLockedReadOnly({ forUuid: targetRawItem.data.uuid })
				toast.warning(t("previewReadOnlyAfterSaveFailure"))
			}

			return
		}

		void loadPreviewBytes(cacheScope, outcome.item.data.uuid, saved.byteLength, () => Promise.resolve(saved))
		// A spreadsheet stays mounted (keyed by its document, see bodyKey) and reports its own dirty bit:
		// edits made during the upload are still unsaved.
		edits.commit?.()
		// Keyed by the FROZEN slot uuid (targetRawItem), never targetItem's own uuid — see `saved`'s own
		// comment on why that's what makes a chained re-save of the same slot collapse onto one entry.
		commitSaved(targetRawItem.data.uuid, outcome.item, true)
		// A cut of the file now moves the saved version, not the one archived under the old uuid.
		followClipboardItem(outcome.item, targetItem.data.uuid)

		// A text editor was read-only through the upload, so it holds exactly what was saved.
		if (edits.commit === null) {
			setPreviewDirty(false)
			// The remounted viewer re-seeds this itself when it mounts an editor; markdown returns in
			// RENDERED mode and mounts none, so a stale buffer would otherwise stay readable to a second save.
			contentRef.current = null
		}

		// Last, so a version saved elsewhere after this one is judged against it.
		remote.saveSettled(outcome.item)
	}

	// What a save uploads, and for a spreadsheet the call that marks that version saved once it landed.
	async function readSaveEdits(): Promise<{ bytes: Uint8Array; commit: (() => void) | null } | null> {
		const source = spreadsheetRef.current

		if (source !== null) {
			return await source()
		}

		const text = contentRef.current?.()

		return text === undefined ? null : { bytes: new TextEncoder().encode(text), commit: null }
	}

	useAction(
		"preview.save",
		keyboardEvent => {
			// Unconditional, mirroring drive.download's own mod+s handler — the browser's native
			// Save-Page-As must never fire here regardless of whether a save is actually possible right now.
			keyboardEvent.preventDefault()

			// Typed in a dialog over the preview (a viewer's own, say a sheet's rename): not a save of the file.
			const target = keyboardEvent.target
			const layer = target instanceof Element ? target.closest("[role='dialog'], [role='alertdialog']") : null

			if (layer !== null && layer !== popupRef.current) {
				return
			}

			void performSave()
		},
		IN_EDITORS_AND_FIELDS,
		[editable, dirty, saving, driveItem, rawDriveItem, remote.prompt, pendingIntent, blocker.status, logoutRequest, menuDialogKind]
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
	function requestOrRun(intent: PreviewDismissIntent, run: () => void): void {
		if (saving) {
			return
		}

		if (dirty) {
			setPendingIntent(intent)
			return
		}

		run()
	}

	function handleOpenChange(next: boolean, details: DialogPrimitive.Root.ChangeEventDetails): void {
		// An Escape something inside took already, the editor's find panel closing say, is not a close:
		// Base UI hears it at the document, after the editor.
		if (!next && details.reason === "escape-key" && details.event.defaultPrevented) {
			details.cancel()

			return
		}

		if (!next) {
			// Chrome always returns on the Escape/backdrop/X close path — unconditionally, even if
			// requestOrRun below ends up only opening the unsaved-changes prompt rather than actually
			// closing: that prompt needs the header visible to read the dialog's own title, and there is no
			// dedicated "close attempted but blocked" branch to hang this off separately.
			setChromeVisible(true)
			requestOrRun("close", onClose)
		}
	}

	// Click-to-hide-chrome: toggles the header (which also carries the pager's prev/next buttons)
	// when the click lands on the media surface itself, never on a button/scrubber/pager control — see
	// shouldToggleChrome's own doc comment for the full decision table and the video-controls-band
	// heuristic that makes a native <video> scrubber click distinguishable from a click on its picture
	// area at all.
	function handleBodyClick(event: ReactMouseEvent<HTMLDivElement>): void {
		const target = event.target

		// A viewer's menus and dialogs portal out of the body, while React still bubbles their clicks here.
		if (!(target instanceof Node) || !event.currentTarget.contains(target)) {
			return
		}
		// `.pdf-text-layer` joins `.cm-editor` as a whole text-SELECTION surface excluded from the toggle:
		// pdf.js's layer covers the entire page with no pointer-events opt-out, so once it exists every
		// click on a PDF page — including the one that concludes a drag-selection — lands on it.
		const isInteractive =
			hasClosest(target) &&
			target.closest(`button, a, [role='button'], .cm-editor, .pdf-text-layer, input, select, textarea, ${PREVIEW_SURFACE}`) !== null
		const isMedia = isMediaTarget(target)
		let mediaControlsBandHit = false

		if (isMedia && target instanceof HTMLMediaElement) {
			const rect = target.getBoundingClientRect()

			mediaControlsBandHit = isVideoControlsBandClick(rect.height, event.clientY - rect.top)
		}

		if (shouldToggleChrome({ isInteractive, isMedia, mediaControlsBandHit })) {
			setChromeVisible(prev => !prev)
		}
	}

	// Base UI's focus trap does not cover focus lost because the focused control DISABLED ITSELF: paging
	// to either end disables the very pager button that was just clicked, and the browser then drops
	// focus on the floor (document.body) rather than moving it anywhere. Because Base UI stops composite
	// keys from reaching the document (see handleKeyDown below), the popup's own handler is the ONLY
	// route to the pager — so once focus lands outside, arrow paging is silently dead until the user
	// clicks back in. Pull it back to the popup, which is focusable (tabIndex -1).
	//
	// Deliberately narrow: only when focus actually fell to <body>. A Base UI menu/dialog opened from the
	// preview header portals OUTSIDE this popup's subtree and legitimately takes focus with it — that
	// lands on a real element, never body, so this never fights it.
	function handlePopupBlur(event: ReactFocusEvent<HTMLDivElement>): void {
		if (event.relatedTarget !== null) {
			return
		}

		// focusout runs BEFORE the browser settles the new focus target; read it a microtask later.
		queueMicrotask(() => {
			const popup = popupRef.current

			if (popup !== null && popup.isConnected && document.activeElement === document.body) {
				popup.focus()
			}
		})
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

		// An open menu wins too, and this one is not a preference — it is a correctness guard. Menu.Portal
		// renders inside this Popup's REACT subtree, so a key pressed in the menu reaches this handler by
		// React propagation wherever the portal put the DOM node, and Base UI only stops a composite key
		// when it actually moves the highlight (ArrowRight moves nothing in a vertical menu). Paging here
		// would leave the menu open while the slot beneath it changes, and this menu is built for the
		// CURRENT slot — so the next click would act on a file the user never opened it for.
		// directoryListing.tsx guards its own clear-selection action off the same signal.
		if (isAnyMenuOpen()) {
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
		const actions = resolveUnsavedConfirm(pendingIntent, blocker.status === "blocked", logoutRequest !== null)

		setPendingIntent(null)
		// The buffer is gone by the user's own choice: drop the dirty bit and the stale content with it.
		// The slot-change effect above cannot cover this one — a discarded "close" answer changes no slot,
		// and a discarded prev/next must be clean BEFORE the step, not after it.
		setPreviewDirty(false)
		contentRef.current = null

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
		}
	}

	if (driveItem === undefined) {
		return null
	}

	const name = driveItemName(driveItem)
	// The newer version the remote-change dialog asks about, for its comparison.
	const remoteTheirs = remote.prompt?.kind === "revised" ? remote.prompt.theirs : undefined

	return (
		<DialogPrimitive.Root
			open
			onOpenChange={handleOpenChange}
		>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-background duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
				<DialogPrimitive.Popup
					ref={popupRef}
					onBlur={handlePopupBlur}
					onKeyDown={handleKeyDown}
					className="fixed inset-0 z-50 flex flex-col bg-background duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
				>
					<header
						className={cn(
							"flex h-14 shrink-0 items-center gap-1 px-4 transition-opacity duration-150",
							// Hidden chrome stays in the DOM and tab-reachable — never display:none, which
							// would drop it from the tab order entirely and could strand focus — just visually
							// faded with pointer-events suppressed, and restored the instant anything inside it
							// receives focus (a Tab press landing on Close, say) so keyboard/AT use is never
							// blocked by an invisible-but-still-focusable control.
							chromeVisible
								? "opacity-100"
								: "pointer-events-none opacity-0 focus-within:pointer-events-auto focus-within:opacity-100"
						)}
					>
						<PreviewName name={name} />
						{editable && dirty ? (
							<Tooltip>
								<TooltipTrigger
									render={
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
									}
								/>
								<TooltipContent>
									{t("previewSaveAction")}
									<Kbd action="preview.save" />
								</TooltipContent>
							</Tooltip>
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
						{variant !== "trash" && downloadable ? (
							<Button
								variant="ghost"
								size="icon-sm"
								disabled={!isOnline}
								aria-label={t("previewDownloadAction")}
								title={!isOnline ? t("common:offlineActionDisabled") : undefined}
								onClick={() => {
									void startDownloads([driveItem])
								}}
							>
								<DownloadIcon />
							</Button>
						) : null}
						{/* Never for a chat/note embed's fabricated linked-file item (isLinkedEmbedItem). Same
						descriptor list + dropdown renderer the tile/row faces' own ⋯ trigger uses (itemMenu.tsx),
						just with "download" hidden (the button above already covers it) and the two extra
						"direct"-outcome hooks wired into this overlay's own per-slot `saved` override / pager
						housekeeping — see previewMenuHiddenActionIds and the handleMenu* functions above. */}
						{!isLinkedEmbedItem(driveItem) ? (
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
										// The move and version-restore dialogs report no outcome, so their echo, whenever it
										// comes, takes the mark; a mark left by a cancelled dialog only quiets a later
										// notice of the same kind.
										if (kind === "move" || kind === "versions") {
											remote.expectOwnChange(driveItem.data.uuid, kind === "move" ? "move" : "restore")
										}

										setMenuDialogKind(kind)
									}}
									onFavoriteToggled={handleMenuFavoriteToggled}
									onRestored={handleMenuRestored}
									hiddenActionIds={previewMenuHiddenActionIds(hiddenMenuActionIds)}
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
					<div
						className="min-h-0 flex-1"
						onClick={handleBodyClick}
					>
						<PreviewErrorBoundary key={slotKey}>
							<PreviewDownloadableProvider downloadable={downloadable}>
								<PreviewBody
									item={driveItem}
									category={pin?.category}
									documentKey={currentDocumentKey}
									editable={editable}
									renamedReadOnly={renamedReadOnly}
									neverEditable={variant !== "drive"}
									locked={saving}
									onDirtyChange={setPreviewDirty}
									contentRef={contentRef}
									spreadsheetRef={spreadsheetRef}
									canSaveCopy={canSaveCopyBeside(driveItem, variant)}
									onOpenFile={opened => {
										if (rawDriveItem !== undefined) {
											commitSaved(rawDriveItem.data.uuid, opened)
										}
									}}
								/>
							</PreviewDownloadableProvider>
						</PreviewErrorBoundary>
					</div>
					{/* Nested confirmation dialog — Base UI supports nesting a dialog inside another normally
					(see versionsDialog.tsx's own identical precedent); this must stay a child of the outer
					Dialog, not a sibling rendered outside it, for the stacked focus-trap/backdrop behavior to
					apply. Shared by close/prev/next — see PreviewDismissIntent — rather than one instance per trigger. */}
					<ConfirmDialog
						open={unsavedPromptOpen(pendingIntent, blocker.status === "blocked", logoutRequest !== null)}
						pending={false}
						title={t("previewUnsavedChangesTitle")}
						body={t("previewUnsavedChangesBody")}
						confirmLabel={t("previewDiscardAction")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={open => {
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
						}}
						onConfirm={handleUnsavedConfirm}
					/>
					{/* The header item-menu's own secondary dialog (rename/move/trash/etc.) — same nesting
					precedent as the unsaved-changes ConfirmDialog above. */}
					{renderMenuDialog()}
					{remote.prompt !== null ? (
						<RemoteChangeDialog
							key={remote.prompt.kind === "revised" ? remote.prompt.theirs.data.uuid : `deleted:${remote.prompt.frozenUuid}`}
							kind={remote.prompt.kind}
							title={t(remote.prompt.kind === "revised" ? "previewRemoteChangedTitle" : "previewRemoteDeletedTitle")}
							body={t(remote.prompt.kind === "revised" ? "previewRemoteChangedBody" : "previewRemoteDeletedBody", { name })}
							renderCompare={
								remoteTheirs !== undefined && editable && isTextCategory(pin.category)
									? mine => (
											<Suspense fallback={<LoadingState size="lg" />}>
												<RemoteFileCompare
													theirs={remoteTheirs}
													mine={mine}
													name={name}
												/>
											</Suspense>
										)
									: undefined
							}
							readMine={() => contentRef.current?.()}
							pending={remote.pending}
							onKeepMine={remote.keepMine}
							onLoadTheirs={remote.loadTheirs}
							// Without a save source (a read-only viewer) there is nothing to write: not offered.
							onSaveMineAsNew={
								editable
									? () => {
											void remote.saveMineAsNewFile()
										}
									: undefined
							}
							onDiscardMine={remote.discardMine}
						/>
					) : null}
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
	const splitAt = previewTitleSplitIndex(name, TAIL_LENGTH)

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

// What a drive slot renders with, and the format its edits are saved in: fixed when the slot opens.
interface SlotPin {
	category: PreviewCategory
	format: string
	// Whether the slot was editable as it mounted.
	editable: boolean
}

// The format edits are written in: text for every text category, the file kind for a spreadsheet (its
// writer follows the kind it opened as, the same judgement the grid's own rename note makes).
function saveFormat(item: DriveItem): string {
	const category = previewType(item)

	if (isTextCategory(category)) {
		return "text"
	}

	if (category !== "spreadsheet") {
		return ""
	}

	const extension = extensionOf(driveItemName(item))

	return `spreadsheet:${spreadsheetSaveFormat(extension) ?? extension}`
}

function slotPin(item: DriveItem, variant: DriveVariant): SlotPin {
	return { category: previewType(item), format: saveFormat(item), editable: isEditable(item, variant) }
}

// What remounts the body. A spreadsheet follows its document (see documentKeys), so the user's own save
// keeps the grid; every other viewer follows the version shown, and a saved text file reopens on what was
// uploaded. By the pinned renderer, so a rename never remounts.
function bodyKey(item: DriveItem, documentKey: string, pin: SlotPin | null): string {
	return pin?.category === "spreadsheet" ? `spreadsheet:${documentKey}` : item.data.uuid
}

interface PreviewBodyProps {
	item: DriveItem
	// The drive slot's pinned renderer (SlotPin).
	category: PreviewCategory | undefined
	documentKey: string
	editable: boolean
	// Read-only because a rename changed the save format: the spreadsheet grid says so.
	renamedReadOnly: boolean
	// Outside the drive nothing is ever editable, so a spreadsheet keeps only what it shows.
	neverEditable: boolean
	// A save in flight: text editors go read-only until it settles.
	locked: boolean
	onDirtyChange: (dirty: boolean) => void
	contentRef: RefObject<(() => string) | null>
	spreadsheetRef: RefObject<SpreadsheetSaveSource | null>
	// Shows another file in this slot's place (the .xlsx an .xls was just saved as).
	onOpenFile: (item: DriveItem) => void
	// A converted copy may be written beside the file (its own drive, however read-only its format).
	canSaveCopy: boolean
}

// Dispatches to the right viewer by category — remounted (keyed by uuid, see the error boundary one
// level up) on every item change so a viewer's own pending/success/error state never flashes the
// previous item's content. Bytes are no longer loaded centrally here: image/video/audio each own their
// own data source (a streamed SW URL or a buffered blob, see imageViewer.tsx/mediaViewer.tsx),
// pdf/docx each own a lazy chunk plus their own whole-buffer load (see pdfViewer.tsx/docxViewer.tsx)
// — a category still rendered by the fallback below (text/code/markdown) has nothing to load yet.
// `editable`/`onDirtyChange`/`contentRef` only ever reach a CodeMirror surface: the "text"/"code"
// case's TextViewer, and the "markdown" case's own source-mode editor — every other category
// ignores them.
//
// A missing category arm cannot ship as a silently blank overlay: the `default` arm at the bottom of
// the switch is the guard (a return-type annotation is not — `ReactNode` includes `undefined`).
function PreviewBody({
	item,
	category: pinnedCategory,
	documentKey,
	editable,
	renamedReadOnly,
	neverEditable,
	locked,
	onDirtyChange,
	contentRef,
	spreadsheetRef,
	onOpenFile,
	canSaveCopy
}: PreviewBodyProps): ReactNode {
	const { t } = useTranslation("preview")

	// Narrows `data.decryptedMeta` to the file-arm's DecryptedFileMeta (which alone carries `.mime`) —
	// previewType/canPreview already guarantee a file arm for every item that ever reaches this
	// component, but that guarantee lives in a plain function's return value, not a type predicate, so
	// TS needs this explicit narrow before a `.mime`/`.name` access type-checks.
	const base = asDirectoryOrFile(item)

	if (base.type !== "file") {
		return null
	}

	const alt = driveItemName(base)
	// The pinned renderer (SlotPin) where the overlay has one.
	// Stored once (rather than switching on the previewType(item) call directly) so the "video"/"audio"
	// case below can pass it straight through as MediaViewer's own narrower category prop without a
	// second, redundant resolution — a raw switch on the call expression doesn't narrow across cases.
	const category = pinnedCategory ?? previewType(item)

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
						<LoadingState
							size="lg"
							className="text-inherit"
						/>
					}
				>
					<PdfViewer
						item={item}
						alt={alt}
					/>
				</Suspense>
			)
		case "spreadsheet":
			return (
				<Suspense
					fallback={
						<LoadingState
							size="lg"
							className="text-inherit"
						/>
					}
				>
					<SpreadsheetViewer
						item={item}
						documentKey={documentKey}
						alt={alt}
						editable={editable}
						{...(renamedReadOnly ? { readOnlyReason: "renamed" as const } : {})}
						neverEditable={neverEditable}
						onDirtyChange={onDirtyChange}
						saveRef={spreadsheetRef}
						onOpenFile={onOpenFile}
						canSaveCopy={canSaveCopy}
					/>
				</Suspense>
			)
		case "docx":
			return (
				<Suspense
					fallback={
						<LoadingState
							size="lg"
							className="text-inherit"
						/>
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
						<LoadingState
							size="lg"
							className="text-inherit"
						/>
					}
				>
					<TextViewer
						item={item}
						alt={alt}
						editable={editable}
						locked={locked}
						onDirtyChange={onDirtyChange}
						contentRef={contentRef}
					/>
				</Suspense>
			)
		case "markdown":
			return (
				<Suspense
					fallback={
						<LoadingState
							size="lg"
							className="text-inherit"
						/>
					}
				>
					<MarkdownViewer
						item={item}
						alt={alt}
						editable={editable}
						locked={locked}
						onDirtyChange={onDirtyChange}
						contentRef={contentRef}
					/>
				</Suspense>
			)
		case "rawImage":
			return (
				<RawImageViewer
					item={item}
					alt={alt}
				/>
			)
		// canPreview excludes "other" from ever reaching the overlay; it stays only as the exhaustive
		// switch's required fallback.
		case "other":
			return (
				<div className="flex size-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
					{t("previewUnsupportedType")}
				</div>
			)
		// Unreachable by construction, and that is the point: `category` narrows to `never` here only
		// while every PreviewCategory has an arm above, so adding one without a viewer is a compile error
		// on this assignment instead of an overlay that renders nothing.
		default: {
			const unhandled: never = category

			return unhandled
		}
	}
}
