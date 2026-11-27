import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, Component, type KeyboardEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useLatestRef } from "@/lib/useLatestRef"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import {
	XIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	ChevronDownIcon,
	DownloadIcon,
	SaveIcon,
	MoreHorizontalIcon,
	PencilIcon,
	PlayIcon
} from "lucide-react"
import { toast } from "sonner"
import { driveItemMime, isLinkedEmbedItem, type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { needsContentSniff } from "@/features/drive/lib/preview.logic"
import { recordContentVerdict } from "@/features/drive/lib/contentVerdicts"
import { startDownloads } from "@/features/drive/lib/download"
import {
	canSaveCopyBeside,
	isViewOnlyPdf,
	isTextCategory,
	ownsWritableFile,
	SaveRefusedError,
	type PresentationSaveEdits,
	type PresentationSaveSource
} from "@/features/drive/lib/previewSave.logic"
import { followClipboardItem } from "@/features/drive/lib/clipboardSync"
import { splicePhotoSave } from "@/features/photos/queries/photos"
import { recordOwnSave } from "@/features/preview/lib/ownSaves"
import { writeEditedCopy } from "@/features/preview/lib/editedCopy"
import { readImageEdits } from "@/features/preview/lib/imageSave"
import { ImageEditor } from "@/features/preview/imageEdit/components/imageEditor"
import { enterImageEdit } from "@/features/preview/imageEdit/editSession"
import type { ImagePageSlot } from "@/features/preview/lib/imagePageSource"
import { VideoEditor, type VideoEditorCommands, type VideoFrameSaveOutcome } from "@/features/preview/videoEdit/components/videoEditor"
import { VIDEO_CANCEL_ACTION } from "@/features/preview/videoEdit/lib/keys"
import type { VideoSaveTarget } from "@/features/preview/videoEdit/types"
import type { ImageEditorCommands, ImageExportSource } from "@/features/preview/imageEdit/types"
import { IN_EDITORS_AND_FIELDS, useAction } from "@/lib/keymap/useAction"
import { log } from "@/lib/log"
import { useIsOnline } from "@/lib/useIsOnline"
import { SplitTitle } from "@/features/preview/components/splitTitle"
import { PreviewBody } from "@/features/preview/components/previewBody"
import { assistantSeesPreview } from "@/features/preview/lib/activeDocumentScope"
import { cn, driveItemName } from "@filen/shared"
import type { FileVerdict } from "@filen/shared"
import { ContentSniffGate } from "@/features/preview/components/contentSniffGate"
import { fileKindVerdict, subscribeFileKindVerdicts } from "@/features/drive/lib/fileKindVerdicts"
import type { DocxSaveSource } from "@/features/preview/components/docxEditor"
import { pdfEngineMemory } from "@/features/pdf/session/engineWorker"
import type { TextState } from "@/features/preview/hooks/usePreviewTextFile"
import type { TextBuffer } from "@/features/preview/lib/textFile"
import type { SpreadsheetSaveSource } from "@/features/spreadsheet/save/sheetSave.logic"
import { RemoteFileCompare } from "@/features/preview/components/remoteCompare"
import { ArchiveListingScope } from "@/features/archive/components/archiveListingScope"
import { PreviewDownloadableProvider } from "@/features/preview/lib/accessMode"
import { PreviewReplaceContext, type PreviewReplaceMake } from "@/features/preview/lib/previewReplace"
import { PasswordDraft, PasswordDraftContext } from "@/features/preview/lib/passwordDraft"
import { stableUuidOf } from "@/features/drive/store/useDriveClipboardStore"
import { PreviewLoading } from "@/features/preview/components/previewErrorState"
import { useSettledSlot } from "@/features/preview/hooks/useSettledSlot"
import {
	isMediaTarget,
	isTextEditingTarget,
	previewDownloadable,
	previewMenuHiddenActionIds,
	slotPinSource,
	unsavedPromptOpen,
	bodyKey,
	copyTargetOf,
	editedCopySuffix,
	imageSaveLabelKey,
	saveFormat,
	slotEditable,
	slotPin,
	type SlotPin,
	type PreviewDismissIntent,
	menuOpening,
	isTypingTarget,
	itemKeyDialog,
	pagerDelta,
	pagerIntent,
	previewOverlayKey,
	PREVIEW_ITEM_SHORTCUTS
} from "@/features/preview/components/previewOverlay.logic"
import { IMAGE_EDITOR_ACTIONS, PREVIEW_OVERLAY_ACTIONS, type PreviewOverlayAction } from "@/features/preview/lib/keymap"
import { imageOverlayKey } from "@/features/preview/imageEdit/lib/keys"
import { isImeKeydown, matchesCombo } from "@filen/shared/keymap"
import { isRecordingCombo, useBindings, type ActionDef } from "@/lib/keymap/registry"
import { bindingOf } from "@/lib/keymap/bindingOf"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { dropPreviewBuffer, setPreviewDirty, usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"
import { clearVideoPlaybackStates } from "@/features/preview/lib/videoContinuity"
import { clearPreviewCache } from "@/features/preview/lib/previewCache"
import { usePreviewAccessMode, usePreviewCacheScope } from "@/features/preview/lib/accessMode"
import { useSlideshow } from "@/features/preview/hooks/useSlideshow"
import { useSlideshowSubfolders, type ShownSlot } from "@/features/preview/hooks/useSlideshowSubfolders"
import { SlideshowSlot } from "@/features/preview/components/slideshowSlot"
import { SlideshowBar } from "@/features/preview/components/slideshowBar"
import { hasTwoSlides, slideKindOf } from "@/features/preview/lib/slideshow.logic"
import { fetchSlideshowTree, type SlideshowSource } from "@/features/preview/lib/slideshowTree"
import { reconcilePreviewSources, subscribePreviewReconcile, type PreviewReconcileEvent } from "@/features/preview/lib/previewReconcile"
import { usePreviewRemoteChanges, type PreviewEdits } from "@/features/preview/hooks/usePreviewRemoteChanges"
import { usePreviewItemMenu } from "@/features/preview/hooks/usePreviewItemMenu"
import { usePreviewDismissal } from "@/features/preview/hooks/usePreviewDismissal"
import { usePreviewSave } from "@/features/preview/hooks/usePreviewSave"
import { usePreviewEditSessions } from "@/features/preview/hooks/usePreviewEditSessions"
import { usePreviewPagerFocus } from "@/features/preview/hooks/usePreviewPagerFocus"
import { RemoteChangeDialog } from "@/features/preview/components/remoteChangeDialog"
import { DriveDropdownMenuContent } from "@/features/drive/components/itemMenu"
import { toggleItemFavorite } from "@/features/drive/lib/favorite"
import { applyOfflineGate, driveItemActions, type ItemActionId } from "@/features/drive/components/itemMenu.logic"
import { type ParentNaming } from "@/features/drive/lib/archiveTargets"
import { Button } from "@/components/ui/button"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Kbd } from "@/lib/keymap/kbd"
import { Spinner } from "@/components/ui/spinner"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { dialogLayerOf, isAnyMenuOpen } from "@/lib/keymap/dialogGuard"
import { PreviewAssistantPane } from "@/features/assistant/components/assistantPanel"
import { PreviewAssistantToggle } from "@/features/assistant/components/assistantToggle"

const IS_MAC = isMacPlatform()
// The two actions an Escape the dialog dismisses on may be: closing, and leaving the image editor.
const CLOSE: ActionDef | undefined = PREVIEW_OVERLAY_ACTIONS.find(def => def.id === "preview.close")
const IMAGE_CANCEL: ActionDef | undefined = IMAGE_EDITOR_ACTIONS.find(def => def.id === "preview.imageCancel")

export interface PreviewOverlayProps {
	variant: DriveVariant
	// Frozen previewable-sibling snapshot taken at open time (directoryListing.tsx's handleOpen) — the
	// pager's whole candidate list, not just the opened item.
	items: DriveItem[]
	index: number
	onStep: (delta: number) => void
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
	// The header menu's Compress for a surface with its own directory names and selection (Photos); the
	// drive's when omitted.
	compressParentNaming?: ParentNaming | undefined
	onSourcesDisposing?: ((uuids: string[]) => void) | undefined
	// False for a public link's file whose owner disallows downloads: nothing here offers to save it.
	// Downloadable when omitted.
	downloadable?: boolean
	// Opened through the item menu's "Open as text": the file shows in the text viewer, view-only.
	asText?: boolean
	// The one directory the pager's list is from, whose subdirectories a slideshow may include. None for a list that is
	// no directory's (photos, recents, favorites, links, trash, search results, the shared roots).
	slideshowSource?: SlideshowSource | undefined
	// Swaps the host's frozen pager list (as opening it with `items` at `index` would): a slideshow's subdirectories'
	// files, and back.
	onItemsReplaced?: ((items: DriveItem[], index: number) => void) | undefined
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
// ui/dialog.tsx) since no full-screen surface exists yet to reuse. Closing asks first while the
// slot has unsaved edits (see requestOrRun): every editor reports them through setPreviewDirty (text and
// code, sheets, Word documents, decks, PDFs, the image and video editors). A viewer's own data load is a
// read-only fetch, never protected against an interrupted close.
export function PreviewOverlay({
	variant,
	items,
	index,
	onStep,
	onClose,
	onItemRemoved,
	onFavoriteToggled,
	hiddenMenuActionIds,
	compressParentNaming,
	onSourcesDisposing,
	downloadable: downloadableProp,
	asText: asTextProp,
	slideshowSource,
	onItemsReplaced
}: PreviewOverlayProps) {
	// Not a parameter default: the React Compiler skips a component that has one.
	const downloadable = downloadableProp !== false
	const asText = asTextProp === true
	// The assistant panel moves into the previews assistantSeesPreview allows, which cover the shell's
	// (PreviewAssistantPane). Public-link pages have no overlay. A pager list is never mixed, so its first item tells.
	const firstItem = items[0]
	const hostsAssistant = firstItem === undefined ? variant !== "trash" : assistantSeesPreview(firstItem, variant)
	const { t } = useTranslation(["preview", "common", "drive"])
	const isOnline = useIsOnline()
	// The drive item at this slot BEFORE any per-slot save override — undefined only for an out-of-range
	// index.
	const rawDriveItem = items[index]
	const popupRef = useRef<HTMLDivElement>(null)
	// Reader for performSave to pull the live buffer without this component
	// re-rendering on every keystroke — see TextViewer's own contentRef prop doc.
	const contentRef = useRef<TextBuffer | null>(null)
	// The spreadsheet editor's side channel: its bytes as edited, serialised when a save asks for them.
	const spreadsheetRef = useRef<SpreadsheetSaveSource | null>(null)
	// The Word document editor's, likewise (written by its lossless writer when a save asks).
	const docxRef = useRef<DocxSaveSource | null>(null)
	// The presentation editor's: a save its worker streams to the upload over a port (the deck is never whole here).
	const presentationRef = useRef<PresentationSaveSource | null>(null)
	// The image viewer's <img>, whose decoded pixels the image editor starts from; and the open image editor's export
	// (what a save writes) and commands (the header's Revert).
	const imageRef = useRef<HTMLImageElement | null>(null)
	// The page a document engine shows instead (a TIFF's), which the image editor draws from that engine.
	const imagePageRef = useRef<ImagePageSlot | null>(null)
	const imageSaveRef = useRef<ImageExportSource | null>(null)
	const imageCommandsRef = useRef<ImageEditorCommands | null>(null)
	// The open video editor's commands (Mod+S opens its Save popover; the remote-change dialog's copy is its export).
	const videoCommandsRef = useRef<VideoEditorCommands | null>(null)
	const cacheScope = usePreviewCacheScope()
	const access = usePreviewAccessMode()

	// The open editor's unsaved edits: encoded, for a deck (never held here as bytes, it may be gigabytes) a save its
	// session streams to an upload, or an edited image's export.
	async function readEdits(): Promise<PreviewEdits | null> {
		// A video's edits are an export, never bytes held here: its own Save as copy stands in (onSaveMineAsNew below).
		if (videoEditing !== null) {
			return null
		}

		if (editing !== null) {
			return await readImageEdits(editing, imageSaveRef.current, editable)
		}

		const edits = await readSaveEdits(false, false)

		return edits === null ? null : "kind" in edits ? edits : edits.bytes
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
	const [pinned, setPinned] = useState<PinnedSlot | null>(null)
	// Single-slot (unlike `saved` above): keyed to the CURRENT pager slot only, so navigating away and
	// back can forget an earlier slot's lock (accepted — the guarded failure re-asserts on the next
	// failed save). Mirrors mobile parity's "a failed save locks the file read-only" rule; cleared by a
	// fresh item or a fresh overlay mount, never by an effect.
	const [lockedReadOnly, setLockedReadOnly] = useState<{ forUuid: string } | null>(null)
	// What the slot's text viewer reports (TextState): text a save would change keeps the slot read-only until the
	// viewer converts it; the encoding a save writes is what a newer version is compared in.
	const [textState, setTextState] = useState<(TextState & { forUuid: string }) | null>(null)
	// The codepage the slot's text was last saved in by this overlay (frozen uuid), and the version that save made:
	// that version is read in it, never detected again (a guess could differ, and the next save would mix codepages).
	// Unicode needs none: its reading is never a guess.
	const [savedReadAs, setSavedReadAs] = useState<{ forUuid: string; versionUuid: string; encoding: string } | null>(null)
	// Not component state: the sign-out path is a plain lib function and has to be able to read this
	// same bit (see usePreviewUnsavedGuard). Boolean-collapsed selector, so the overlay still re-renders
	// on the dirty EDGE only.
	const dirty = usePreviewUnsavedGuardStore(state => state.dirty)
	const logoutRequest = usePreviewUnsavedGuardStore(state => state.logoutRequest)
	const [saving, setSaving] = useState(false)
	const [pendingIntent, setPendingIntent] = useState<PreviewDismissIntent | null>(null)

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

	// What a "replace" intent runs once the edits are discarded; kept through the prompt's close (WebKit can report
	// it before the confirm), cleared by the confirm and replaced by the next request.
	const pendingReplaceRef = useRef<(() => void) | null>(null)
	// A menu action's Try again can land after this overlay closed, where closing it would close whatever
	// dialog replaced it.
	const mountedRef = useRef(false)

	useEffect(() => {
		mountedRef.current = true

		return () => {
			mountedRef.current = false
		}
	}, [])
	// The resolved slot the body actually renders, carrying its per-slot save override. Undefined only for
	// an out-of-range index.
	const driveItem = rawDriveItem !== undefined ? (saved.get(rawDriveItem.data.uuid) ?? rawDriveItem) : undefined
	const currentDocumentKey = rawDriveItem === undefined ? "" : (documentKeys.get(rawDriveItem.data.uuid) ?? rawDriveItem.data.uuid)
	// The password being typed into the file's prompt, for the slot on screen and the file it shows (its stable
	// uuid, which its versions share): a newer version shown meanwhile remounts the viewer, whose prompt takes it
	// up. Stepping to another slot or file starts a new one.
	const draftKey =
		rawDriveItem === undefined || driveItem === undefined ? "" : `${rawDriveItem.data.uuid}/${stableUuidOf(driveItem) ?? ""}`
	const [passwordDraft, setPasswordDraft] = useState(() => ({ key: draftKey, draft: new PasswordDraft() }))

	if (passwordDraft.key !== draftKey) {
		setPasswordDraft({ key: draftKey, draft: new PasswordDraft() })
	}
	// The drive slot's renderer and save format, as it mounted: a rename never swaps the viewer (and with it
	// the unsaved edits) out from under the user. Taken again whenever the slot mounts anew, which is only
	// ever clean (stepping to it, or a new document, see documentKeys): its name as it stands then decides.
	// A `.ts` waiting on its probe (ContentSniffGate) has no viewer yet: the verdict that ends the wait
	// takes it once more, by the name it was pinned under; so does a `.dot` the docx viewer found to be text. A
	// verdict landing after a viewer mounted (an audio-only `.webm` found out mid-playback) leaves it be until the
	// slot is opened again.
	const streamVerdict = useSyncExternalStore(subscribeFileKindVerdicts, () =>
		driveItem === undefined ? undefined : fileKindVerdict(driveItem.data.uuid)
	)
	const pinFrom = slotPinSource(pinned, { documentKey: currentDocumentKey, item: driveItem, verdict: streamVerdict })
	const pdfEditMaxBytes = pdfEngineMemory().editMaxBytes
	const derivedPin = pinFrom === null ? null : slotPin(pinFrom, variant, asText, pdfEditMaxBytes)
	const pin = driveItem === undefined ? null : (derivedPin ?? pinned?.pin ?? null)

	if (pinFrom !== null && derivedPin !== null) {
		setPinned({
			documentKey: currentDocumentKey,
			item: pinFrom,
			verdict: streamVerdict,
			awaitingVerdict: !asText && needsContentSniff(pinFrom) !== null,
			pin: derivedPin
		})
	}

	// Compared against the FROZEN pre-save uuid (rawDriveItem), never the possibly-rotated override's uuid — see
	// `saved`'s own comment on why that's the stable key. A rename to another format leaves the open
	// viewer read-only: what it holds would be saved under a name that says otherwise.
	// `slotWritable` is what the viewer is asked for; a text viewer may still find its file read-only (textState).
	const slotWritable =
		rawDriveItem !== undefined &&
		driveItem !== undefined &&
		pin !== null &&
		!asText &&
		slotEditable(driveItem, variant, pdfEditMaxBytes) &&
		saveFormat(driveItem) === pin.format &&
		lockedReadOnly?.forUuid !== rawDriveItem.data.uuid
	const slotText = textState !== null && textState.forUuid === rawDriveItem?.data.uuid ? textState : null
	const readAs =
		savedReadAs !== null && savedReadAs.forUuid === rawDriveItem?.data.uuid && savedReadAs.versionUuid === driveItem?.data.uuid
			? savedReadAs.encoding
			: null
	const editable = slotWritable && slotText?.writable !== false
	// Read-only only because a rename changed the format the open edits would be saved in.
	const renamedReadOnly = driveItem !== undefined && pin?.editable === true && saveFormat(driveItem) !== pin.format
	// The image and video editors' sessions on the slot on screen, and whether either may open on it.
	const {
		setEditState,
		editing,
		enteringEdit,
		setEnteringEdit,
		enterAbortRef,
		imageEditable,
		imagePrimaryTarget,
		videoMode,
		videoEditing,
		videoEditable,
		videoExportRunning,
		anyEditing
	} = usePreviewEditSessions({ variant, asText, driveItem, rawDriveItem, pin, editable })

	// `ownSave`: `item` is what this overlay's own save of the slot made.
	function commitSaved(frozenUuid: string, item: DriveItem, ownSave?: boolean): void {
		const shownUuid = savedRef.current.get(frozenUuid)?.data.uuid ?? frozenUuid

		// Saved from a text editor, the new version (a new uuid) is text: no probe needs to ask again.
		if (ownSave === true && pin !== null && isTextCategory(pin.category)) {
			recordContentVerdict(
				{ uuid: item.data.uuid, name: driveItemName(item), mime: driveItemMime(item), size: item.data.size },
				"notTransportStream"
			)
		}

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
	// The header's item menu: its dropdown, the dialog an entry opened, and what each entry runs on the slot on screen.
	const { menuDialogKind, openMenuDialog, menuOpen, setMenuOpen, handleMenuFavoriteToggled, handleMenuRestored, renderMenuDialog } =
		usePreviewItemMenu({
			variant,
			driveItem,
			rawDriveItem,
			saving,
			remote,
			mountedRef,
			commitSaved,
			onItemRemoved,
			onClose,
			onFavoriteToggled,
			onSourcesDisposing,
			compressParentNaming
		})
	// A question is up: the remote-change one, a menu action's dialog, or the unsaved-changes prompt an in-app intent
	// opened. Nothing starts behind it.
	const dialogOpen = remote.prompt !== null || pendingIntent !== null || menuDialogKind !== null
	// A slideshow over the pager; it never steps away from a slot that cannot be left (requestOrRun's conditions), nor
	// from under a question about the file on screen, which it would then act on.
	const slideshow = useSlideshow({
		items,
		index,
		step: onStep,
		canLeave: () => !dirty && !saving && !dialogOpen,
		cacheScope,
		access
	})
	// Offered on a slide over at least two slides of the list (kept while one runs); never in the trash, where Delete
	// deletes for good.
	const slideshowOffered =
		slideshow.running ||
		(variant !== "trash" && rawDriveItem !== undefined && slideKindOf(rawDriveItem) !== null && hasTwoSlides(items))

	// Swaps the pager's list, kept on the file on screen when the new list has it, else on `fallbackUuid`'s file when it
	// has that, else on its first item; never away from a slot that cannot be left.
	function replaceItems(next: DriveItem[], { shown, locked }: ShownSlot, fallbackUuid: string | undefined): boolean {
		// Every file of the opening list is gone: the slideshow's list stays.
		if (next.length === 0) {
			return true
		}

		const indexOf = (uuid: string | undefined): number => (uuid === undefined ? -1 : next.findIndex(item => item.data.uuid === uuid))
		const own = indexOf(shown)
		const at = own === -1 ? indexOf(fallbackUuid) : own

		if (onItemsReplaced === undefined || (own === -1 && locked)) {
			return false
		}

		onItemsReplaced(next, Math.max(at, 0))

		return true
	}

	// "Include subdirectories": the subdirectories' list stands in for the one the overlay was opened with.
	const subfolders = useSlideshowSubfolders({
		slideshow,
		offered: slideshowOffered,
		source: onItemsReplaced === undefined ? undefined : slideshowSource,
		list: items,
		shown: { shown: rawDriveItem?.data.uuid, locked: dirty || saving },
		load: fetchSlideshowTree,
		listOf: tree => (hasTwoSlides(tree) ? tree : null),
		replace: replaceItems,
		logScope: "preview",
		onRunningChange: () => {
			const popup = popupRef.current

			// The header (▶) or the bar (✕) that held focus is gone: focus stays in the dialog, for its keys.
			if (popup !== null && !popup.contains(document.activeElement)) {
				popup.focus()
			}
		}
	})
	const startSlideshow = subfolders.start
	const holdsOpening = subfolders.swapped !== null

	const followOpening = useEffectEvent((event: PreviewReconcileEvent) => {
		subfolders.updateOpening(held => {
			const next = reconcilePreviewSources({ items: held, index: 0 }, event)

			return next === null ? [] : next.items
		})
	})

	// The opening list follows the files removed, moved or renamed meanwhile, as the host's list does.
	useEffect(() => {
		if (!holdsOpening) {
			return
		}

		return subscribePreviewReconcile(event => {
			followOpening(event)
		})
	}, [holdsOpening])

	// Neither does a new edit mode while one is open, being entered, or saving, nor under a slideshow.
	const editStartBlocked = anyEditing || enteringEdit || saving || dialogOpen || slideshow.running

	// Opens the image on screen in the editor, or says why it cannot. Not while anything else is under way or asked.
	function startImageEdit(): void {
		const item = driveItem
		const raw = rawDriveItem

		if (!imageEditable || item === undefined || raw === undefined || editStartBlocked) {
			return
		}

		const controller = new AbortController()
		const slot = `${raw.data.uuid}/${item.data.uuid}`

		enterAbortRef.current?.abort()
		enterAbortRef.current = controller
		setEnteringEdit(true)

		void enterImageEdit({
			item,
			frozenUuid: raw.data.uuid,
			cacheScope,
			image: imageRef.current,
			page: imagePageRef.current,
			signal: controller.signal
		}).then(outcome => {
			if (enterAbortRef.current === controller) {
				enterAbortRef.current = null
			}

			// Gone, or another file on screen by now: the session is never shown, so it ends here.
			if (!mountedRef.current || currentSlotRef.current !== slot) {
				if (outcome.status === "ready") {
					outcome.state.release()
				}

				if (mountedRef.current) {
					setEnteringEdit(false)
				}

				return
			}

			setEnteringEdit(false)

			if (outcome.status === "refused") {
				toast.error(t(outcome.messageKey))
			} else if (outcome.status === "ready") {
				setEditState(outcome.state)
			}
		})
	}

	// Edits are dropped by the caller's choice (or there were none).
	function exitImageEdit(): void {
		setEditState(null)
		dropPreviewBuffer(contentRef)
	}

	// The header's Cancel, Escape and Back in edit mode: asks first over unsaved edits.
	function requestExitImageEdit(): void {
		requestOrRun("exitEdit", exitImageEdit)
	}

	// Opens the video on screen in the editor (the source read once), or says why it cannot.
	function startVideoEdit(): void {
		const item = driveItem
		const raw = rawDriveItem

		if (!videoEditable || item === undefined || raw === undefined || videoMode.entering || editStartBlocked) {
			return
		}

		// Reached by the key while the button is disabled.
		if (videoExportRunning) {
			toast.error(t("previewVideoEditExportRunning"))

			return
		}

		void videoMode.enter(item, raw.data.uuid).then(outcome => {
			if (!mountedRef.current) {
				return
			}

			if (outcome === "unavailable") {
				toast.error(t("previewVideoEditUnavailable"))
			} else if (outcome === "failed") {
				toast.error(t("previewVideoEditLoadFailed"))
			}
		})
	}

	// Edits are dropped by the caller's choice (or there were none, or they were saved).
	function exitVideoEdit(): void {
		videoMode.exit()
		dropPreviewBuffer(contentRef)
	}

	// The editor's Cancel, Escape and Back: asks first over unsaved edits; never while an export runs in the editor
	// (its own Cancel export or Continue in background decide that).
	function requestExitVideoEdit(): void {
		if (videoCommandsRef.current?.exporting() !== true) {
			requestOrRun("exitEdit", exitVideoEdit)
		}
	}

	// A video export started from the slot on screen: what it saved is shown (a new version) or noted (a copy) when it
	// ends, wherever the user is by then, and versions saved elsewhere meanwhile are judged against it.
	function videoSaveStarted(target: VideoSaveTarget): (saved: DriveItem | null) => void {
		const item = driveItem
		const frozenUuid = rawDriveItem?.data.uuid

		remote.saveStarted()

		return saved => {
			if (!mountedRef.current) {
				return
			}

			const settled = videoSaveSettledRef.current

			settled(saved, target, item, frozenUuid)
		}
	}

	function videoSaveSettled(
		saved: DriveItem | null,
		target: VideoSaveTarget,
		item: DriveItem | undefined,
		frozenUuid: string | undefined
	): void {
		if (saved === null || item === undefined || frozenUuid === undefined) {
			remote.saveSettled(null)

			return
		}

		if (target === "copy") {
			recordOwnSave(saved.data.uuid)
			splicePhotoSave(item.data.uuid, saved, "beside")
			remote.saveSettled(null)

			return
		}

		commitSaved(frozenUuid, saved, true)
		followClipboardItem(saved, item.data.uuid)
		splicePhotoSave(item.data.uuid, saved, "replace")
		remote.saveSettled(saved)
	}

	// A still of the video beside it, named as an edited copy ("clip (edited).jpg").
	async function saveVideoFrame(blob: Blob, extension: "jpg"): Promise<VideoFrameSaveOutcome> {
		const item = driveItem

		if (item === undefined) {
			return { status: "unavailable" }
		}

		const written = await writeEditedCopy(item, { blob }, extension, editedCopySuffix)

		if (written === null) {
			return { status: "unavailable" }
		}

		if (written.outcome.status === "error") {
			return { status: "error", dto: written.outcome.dto }
		}

		recordOwnSave(written.outcome.item.data.uuid)

		return { status: "success", name: written.name }
	}

	// Keyboard focus kept inside the popup as the pager steps (usePreviewPagerFocus).
	const handlePopupBlur = usePreviewPagerFocus(popupRef, index)

	// videoContinuity.ts's position map is scoped to exactly one overlay SESSION — this component itself
	// only ever mounts while a preview is open (useDriveDialogHost's conditional render), so its own
	// unmount is precisely "the overlay closed"; clearing here (rather than in onClose, which the header
	// item-menu's own Trash/Unshare success paths also call, all funneling through the SAME close) keeps
	// this a single, unconditional cleanup with no risk of missing a dismissal route. The preview
	// byte cache is scoped the same way, so a closed overlay stops holding file buffers; the archive
	// listings live in the ArchiveListingScope below and go with it.
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
	const slotSettled = useSettledSlot(slotKey)

	useEffect(() => {
		dropPreviewBuffer(contentRef)
	}, [slotKey])

	// The slot and version on screen, for work that settles later (opening the editor, a copy's Open).
	const currentSlotRef = useLatestRef(
		rawDriveItem === undefined || driveItem === undefined ? null : `${rawDriveItem.data.uuid}/${driveItem.data.uuid}`
	)

	// Opening the editor for a file no longer on screen stops.
	useEffect(() => {
		return () => {
			enterAbortRef.current?.abort()
		}
	}, [slotKey, enterAbortRef])

	// Every way out of the overlay while it holds unsaved edits: the browser's Back, a navigation that unmounts it, a
	// tab close, a waiting sign-out, and the unsaved-changes prompt that answers them.
	const { blocker, logoutAsks, handleUnsavedConfirm, handleUnsavedOpenChange } = usePreviewDismissal({
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
	})

	// A save is never started under a question (dialogOpen), nor under the unsaved-changes prompt a blocked navigation
	// or a waiting sign-out opened: over the remote-change question it would decide it for the user, and from a prompt
	// or a menu dialog it would act behind it.
	const saveBlocked = dialogOpen || unsavedPromptOpen(pendingIntent, blocker.status === "blocked", logoutRequest !== null)

	// What a save uploads, and for a spreadsheet the call that marks that version saved once it landed; for a deck,
	// the save its session streams; for text, the encoding the bytes are in. Text its encoding cannot hold is refused:
	// with `explain` the editor's dialog says why (silently here), else the refusal carries the reason.
	async function readSaveEdits(
		auto: boolean,
		explain: boolean
	): Promise<{ bytes: Uint8Array; commit: (() => void) | null; encoding?: string } | PresentationSaveEdits | null> {
		if (presentationRef.current !== null) {
			return await presentationRef.current({ auto })
		}

		if (spreadsheetRef.current !== null) {
			return await spreadsheetRef.current()
		}

		if (docxRef.current !== null) {
			return await docxRef.current({ auto })
		}

		const buffer = contentRef.current

		if (buffer === null) {
			return null
		}

		const encoded = buffer.bytes()

		if ("unencodable" in encoded) {
			if (explain) {
				buffer.explain(encoded.unencodable)
			}

			throw new SaveRefusedError(explain ? "previewTextUnencodableTitle" : "previewTextUnencodableSaveAsNew", { silent: explain })
		}

		return slotText === null
			? { bytes: encoded.bytes, commit: null }
			: { bytes: encoded.bytes, commit: null, encoding: slotText.encoding }
	}

	const startImageEditRef = useLatestRef(startImageEdit)
	const startVideoEditRef = useLatestRef(startVideoEdit)
	// A video export's end, as things stand when it comes (the export may outlive the editor that started it).
	const videoSaveSettledRef = useLatestRef(videoSaveSettled)

	// The overlay's saves: the text, sheet, Word document, deck and PDF editors' (performSave), and the image editor's.
	const { performSave, performSaveRef, saveImage } = usePreviewSave({
		cacheScope,
		driveItem,
		rawDriveItem,
		editable,
		dirty,
		saving,
		setSaving,
		saveBlocked,
		anyEditing,
		editing,
		imagePrimaryTarget,
		videoEditing,
		videoCommandsRef,
		imageSaveRef,
		contentRef,
		mountedRef,
		currentSlotRef,
		remote,
		readSaveEdits,
		commitSaved,
		exitImageEdit,
		setLockedReadOnly,
		setSavedReadAs
	})

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

			performSave()
		},
		IN_EDITORS_AND_FIELDS,
		[
			editable,
			dirty,
			saving,
			driveItem,
			rawDriveItem,
			remote.prompt,
			pendingIntent,
			blocker.status,
			logoutRequest,
			menuDialogKind,
			editing,
			imagePrimaryTarget,
			videoEditing
		]
	)

	// A no-op unless the slot shows an image the editor opens (startImageEdit's guards).
	useAction("preview.editImage", () => {
		startImageEditRef.current()
	})

	// Likewise for a video (startVideoEdit's guards); unbound until the user assigns it.
	useAction("preview.editVideo", () => {
		startVideoEditRef.current()
	})

	// The overlay's own keys (handleKeyDown) and its menu's ⋯ trigger, which Shift+F10 opens.
	const bindings = useBindings()
	const menuTriggerRef = useRef<HTMLButtonElement | null>(null)

	// Mod+S downloads a file that cannot be edited, as the listings' key does; an editable one (and the image editor) is
	// preview.save's. Taken in this layer only, never under a dialog over it, and always kept from the browser's Save
	// Page As, as the save is.
	useAction(
		"preview.download",
		keyboardEvent => {
			const target = keyboardEvent.target
			const layer = target instanceof Element ? dialogLayerOf(target) : null

			if (layer !== null && layer !== popupRef.current) {
				return
			}

			keyboardEvent.preventDefault()

			if (
				editable ||
				anyEditing ||
				keyboardEvent.repeat ||
				!isOnline ||
				isAnyMenuOpen() ||
				driveItem === undefined ||
				!previewDownloadable(downloadable, variant)
			) {
				return
			}

			// As the header's Download.
			void startDownloads([driveItem])
		},
		IN_EDITORS_AND_FIELDS,
		[editable, anyEditing, isOnline, driveItem, downloadable, variant]
	)

	// Another file in this slot (File ▸ New presentation, made by `make` once allowed) drops the buffer: asked about
	// first like close/prev/next, so nothing is made when the user keeps the edits; also asked while a save is in
	// flight, whose own commit would put the saved file back in the slot.
	function requestReplace(make: PreviewReplaceMake): void {
		if (rawDriveItem === undefined) {
			return
		}

		const frozenUuid = rawDriveItem.data.uuid
		const run = (): void => {
			make(item => {
				commitSaved(frozenUuid, item)
			})
		}

		if (!dirty && !saving) {
			run()

			return
		}

		pendingReplaceRef.current = run
		setPendingIntent("replace")
	}

	// One identity for the editors' context, reading this render's state when called.
	const requestReplaceRef = useLatestRef(requestReplace)
	const [replaceInSlot] = useState(() => (make: PreviewReplaceMake) => {
		requestReplaceRef.current(make)
	})

	function handleOpenChange(next: boolean, details: DialogPrimitive.Root.ChangeEventDetails): void {
		// An Escape something inside took already, the editor's find panel closing say, is not a close:
		// Base UI hears it at the document, after the editor.
		if (!next && details.reason === "escape-key" && details.event.defaultPrevented) {
			details.cancel()

			return
		}

		// Nor is one meant for a menu still opening: closing the document (or asking about its unsaved edits)
		// instead would surprise.
		if (!next && details.reason === "escape-key" && menuOpening(document)) {
			details.cancel()

			return
		}

		// Escape closes only while it is the close key (preview.close), or in edit mode the image editor's leave key; the
		// user may have moved either off it. The close button and the backdrop are no keys.
		const escape = !next && details.reason === "escape-key"
		const event = details.event
		const pressed = (def: ActionDef | undefined): boolean =>
			def !== undefined &&
			event instanceof KeyboardEvent &&
			!event.repeat &&
			!isRecordingCombo() &&
			matchesCombo(event, bindingOf(bindings, def, IS_MAC), IS_MAC)

		// In edit mode (no close button, the header's Cancel instead) Escape leaves edit mode, not the preview.
		if (!next && editing !== null) {
			details.cancel()

			if (!escape || pressed(IMAGE_CANCEL)) {
				requestExitImageEdit()
			}

			return
		}

		// The video editor likewise, by its own leave key.
		if (!next && videoEditing !== null) {
			details.cancel()

			if (!escape || pressed(VIDEO_CANCEL_ACTION)) {
				requestExitVideoEdit()
			}

			return
		}

		// A running slideshow's Escape ends it; the preview stays open on the file.
		if (escape && slideshow.running) {
			details.cancel()
			slideshow.stop()

			return
		}

		if (escape && !pressed(CLOSE)) {
			details.cancel()

			return
		}

		if (!next) {
			requestOrRun("close", onClose)
		}
	}

	// Base UI's DialogPopup calls event.stopPropagation() for every composite key (Arrow*/Home/End) in
	// its own onKeyDown (dialog/popup/DialogPopup.js + internals/composite/composite.js's
	// COMPOSITE_KEYS, verified against the installed package) before it can bubble to the document-level
	// keymap listener useAction/react-hotkeys-hook registers — so the pager's ArrowLeft/ArrowRight cannot
	// be a registered action while the dialog holds focus. Merged onKeyDown props run right-to-left
	// (merge-props.js), so a handler passed directly on Popup (below) still runs BEFORE that internal
	// stopPropagation — this is that handler, mirroring moveTargetDialog.tsx's own local onKeyDown for the
	// identical in-dialog-focus-trap reason.
	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
		const native = event.nativeEvent

		if (event.defaultPrevented || isImeKeydown(native) || isRecordingCombo()) {
			return
		}

		// An open menu wins, and this one is not a preference — it is a correctness guard. Menu.Portal
		// renders inside this Popup's REACT subtree, so a key pressed in the menu reaches this handler by
		// React propagation wherever the portal put the DOM node, and Base UI only stops a composite key
		// when it actually moves the highlight (ArrowRight moves nothing in a vertical menu). Paging here
		// would leave the menu open while the slot beneath it changes, and this menu is built for the
		// CURRENT slot — so the next click would act on a file the user never opened it for.
		// directoryListing.tsx guards its own clear-selection action off the same signal. A key in a dialog
		// over the preview (one portaled from inside it, a rename say) is that dialog's.
		const target = event.target
		const layer = target instanceof Element ? dialogLayerOf(target) : null

		if (isAnyMenuOpen() || (layer !== null && layer !== popupRef.current)) {
			return
		}

		// The video editor takes every key of its own (its layer, useEditorLayerKeys); Escape leaves it through the
		// dialog's own dismissal (handleOpenChange).
		if (videoEditing !== null) {
			return
		}

		// The image editor takes its own keys; its save as copy and cancel are the header's, here. Escape leaves it
		// through the dialog's own dismissal (handleOpenChange).
		if (editing !== null) {
			const action = isTypingTarget(target) ? undefined : imageOverlayKey(native, bindings, IS_MAC)

			if (action === undefined || (action === "preview.imageCancel" && event.key === "Escape")) {
				return
			}

			event.preventDefault()

			if (event.repeat) {
				return
			}

			if (action === "preview.imageSaveCopy") {
				saveImage(copyTargetOf(editing))
			} else {
				requestExitImageEdit()
			}

			return
		}

		const action = previewOverlayKey(native, bindings, IS_MAC)

		if (action === undefined) {
			return
		}

		// A focused media scrubber wins over the pager — native seek expectation (see
		// previewOverlay.logic.ts's isMediaTarget). A focused CodeMirror surface wins too — its own arrow bindings move the cursor/
		// selection and never stopPropagation, so without this a Left/Right meant for the caret would
		// also page the overlay (or pop the unsaved-changes prompt on every press) — see
		// previewOverlay.logic.ts's own isTextEditingTarget for why this checks read-only CodeMirror
		// too, not just the editable case. The same holds for every key here (Delete, F2) but a close on
		// Ctrl or Cmd, which nothing that edits takes (the desktop app's Ctrl+W).
		if ((isMediaTarget(target) || isTextEditingTarget(target)) && !(action === "preview.close" && (event.ctrlKey || event.metaKey))) {
			return
		}

		// Escape closes through the dialog's own dismissal (handleOpenChange), which knows about the layers over it.
		if (action === "preview.close" && event.key === "Escape") {
			return
		}

		// S starts a slideshow; Space pauses one only while it runs, and is otherwise left to what has focus.
		if (subfolders.runKey(action, event)) {
			return
		}

		event.preventDefault()

		const delta = pagerDelta(action, index, items.length)

		if (delta !== null) {
			requestOrRun(pagerIntent(action), () => {
				onStep(delta)
			})

			return
		}

		// Held, only the pager steps on.
		if (event.repeat) {
			return
		}

		runOverlayKey(action)
	}

	// The overlay's keys past the pager: close, and the header's menu and its entries.
	function runOverlayKey(action: PreviewOverlayAction): void {
		if (driveItem === undefined) {
			return
		}

		if (action === "preview.close") {
			requestOrRun("close", onClose)

			return
		}

		// A chat's or a note's linked file has no menu (isLinkedEmbedItem), so no menu keys either; nor does a running
		// slideshow, whose next slide would be the file a dialog opened now acts on.
		if (isLinkedEmbedItem(driveItem) || saving || menuDialogKind !== null || slideshow.running) {
			return
		}

		if (action === "preview.openMenu") {
			menuTriggerRef.current?.click()

			return
		}

		const descriptors = applyOfflineGate(driveItemActions(driveItem, variant), isOnline)
		const hidden = previewMenuHiddenActionIds(hiddenMenuActionIds, previewDownloadable(downloadable, variant))
		const offered = descriptors.filter(descriptor => !hidden.has(descriptor.id))

		// Favorite runs in place, as the menu's own entry, where the menu offers it enabled.
		if (action === "preview.favorite") {
			if (offered.some(descriptor => descriptor.id === "favorite" && descriptor.enabled !== false)) {
				void toggleItemFavorite(driveItem, variant, handleMenuFavoriteToggled)
			}

			return
		}

		const kind = itemKeyDialog(action, offered)

		if (kind === null) {
			return
		}

		// As the menu's own entries (onItemAction below).
		if (kind === "move" || kind === "versions") {
			remote.expectOwnChange(driveItem.data.uuid, kind === "move" ? "move" : "restore")
		}

		openMenuDialog(kind)
	}

	if (driveItem === undefined) {
		return null
	}

	const name = driveItemName(driveItem)
	// The header's Download, also handed to the viewers for a file they cannot show.
	const download = previewDownloadable(downloadable, variant)
		? () => {
				void startDownloads([driveItem])
			}
		: null
	// The newer version the remote-change dialog asks about, for its comparison.
	const remoteTheirs = remote.prompt?.kind === "revised" ? remote.prompt.theirs : undefined

	return (
		<DialogPrimitive.Root
			open
			onOpenChange={handleOpenChange}
		>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-background duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
				{/* The popup, not its first tabbable: that is the header's Edit on an image, whose tooltip opens on
				    keyboard focus and takes the first Escape. */}
				<DialogPrimitive.Popup
					ref={popupRef}
					initialFocus={popupRef}
					onBlur={handlePopupBlur}
					onKeyDown={handleKeyDown}
					className={cn(
						"fixed inset-0 z-50 flex flex-col bg-background duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
						// Edit mode is a darkroom in either app theme, its header included (see ImageEditor, VideoEditor).
						anyEditing && "dark bg-canvas text-foreground scheme-dark"
					)}
				>
					{/* Window chrome on desktop: below the Windows/Linux controls band, clear of the macOS lights. The video
					    editor brings its own header. */}
					{slideshow.running ? <DialogPrimitive.Title className="sr-only">{name}</DialogPrimitive.Title> : null}
					{videoEditing !== null || slideshow.running ? null : (
						<header className="flex h-[calc(3.5rem+var(--window-inset-top))] shrink-0 items-center gap-1 px-4 pt-(--window-inset-top) pl-[max(1rem,var(--window-inset-left))] app-region-chrome">
							{editing !== null && imagePrimaryTarget !== null ? (
								<>
									{/* Equal-growing sides keep the name centred over the picture. */}
									<div className="flex flex-1 basis-0 items-center">
										<Button
											variant="ghost"
											size="sm"
											disabled={saving}
											onClick={requestExitImageEdit}
										>
											{t("previewImageSaveCancelAction")}
										</Button>
									</div>
									{/* Named for assistive tech only at phone width, where the actions need the whole row. */}
									<DialogPrimitive.Title className="flex min-w-0 shrink justify-center px-2 font-heading text-sm font-medium max-sm:sr-only">
										<SplitTitle
											text={name}
											tailLength={16}
										/>
									</DialogPrimitive.Title>
									<div className="flex flex-1 basis-0 items-center justify-end gap-1">
										<Button
											variant="ghost"
											size="sm"
											disabled={!dirty || saving}
											onClick={() => {
												imageCommandsRef.current?.revert()
											}}
										>
											{t("previewImageSaveRevertAction")}
										</Button>
										{editing.pageOnly ? (
											<span className="px-1 text-xs whitespace-nowrap text-muted-foreground max-sm:hidden">
												{t("previewImageSaveCopyPage")}
											</span>
										) : null}
										{/* A copy is the other way to save where the primary writes in place; a copy-only format has just the one. */}
										<div className="flex items-center">
											<Button
												size="sm"
												disabled={!dirty || saving}
												className={cn(imagePrimaryTarget.kind === "inPlace" && "rounded-r-none")}
												onClick={() => {
													saveImage(imagePrimaryTarget)
												}}
											>
												{saving ? <Spinner data-icon="inline-start" /> : null}
												{t(imageSaveLabelKey(imagePrimaryTarget))}
											</Button>
											{imagePrimaryTarget.kind === "inPlace" ? (
												<DropdownMenu>
													<DropdownMenuTrigger
														render={
															<Button
																size="icon-sm"
																disabled={!dirty || saving}
																aria-label={t("previewImageSaveMoreAction")}
																className="rounded-l-none border-l-primary-foreground/20"
															/>
														}
													>
														<ChevronDownIcon />
													</DropdownMenuTrigger>
													{/* Portaled outside the darkroom subtree: dark on its own. */}
													<DropdownMenuContent
														align="end"
														className="dark scheme-dark"
													>
														<DropdownMenuItem
															onClick={() => {
																saveImage(copyTargetOf(editing))
															}}
														>
															{t("previewImageSaveAsCopyAction")}
														</DropdownMenuItem>
													</DropdownMenuContent>
												</DropdownMenu>
											) : null}
										</div>
									</div>
								</>
							) : (
								<>
									<PreviewName name={name} />

									{imageEditable ? (
										<TooltipIconButton
											label={t("previewImageSaveEditAction")}
											disabled={enteringEdit || saving}
											shortcut={<Kbd action="preview.editImage" />}
											onClick={startImageEdit}
										>
											{enteringEdit ? <Spinner className="size-4" /> : <PencilIcon />}
										</TooltipIconButton>
									) : null}
									{videoEditable ? (
										<TooltipIconButton
											label={t("previewVideoEditOpen")}
											disabled={videoMode.entering || saving || videoExportRunning}
											title={videoExportRunning ? t("previewVideoEditExportRunning") : undefined}
											shortcut={<Kbd action="preview.editVideo" />}
											onClick={startVideoEdit}
										>
											{videoMode.entering ? <Spinner className="size-4" /> : <PencilIcon />}
										</TooltipIconButton>
									) : null}
									{/* A PDF's Save sits in its ribbon (with Save as copy, Undo, Redo and Discard). */}
									{editable && dirty && pin.category !== "pdf" ? (
										<TooltipIconButton
											label={t("previewSaveAction")}
											disabled={saving}
											shortcut={<Kbd action="preview.save" />}
											onClick={() => {
												performSave()
											}}
										>
											{saving ? <Spinner className="size-4" /> : <SaveIcon />}
										</TooltipIconButton>
									) : null}
									<TooltipIconButton
										label={t("previewPreviousAction")}
										disabled={index <= 0 || saving}
										shortcut={<Kbd action="preview.prev" />}
										onClick={() => {
											requestOrRun("prev", () => {
												onStep(-1)
											})
										}}
									>
										<ChevronLeftIcon />
									</TooltipIconButton>
									<TooltipIconButton
										label={t("previewNextAction")}
										disabled={index >= items.length - 1 || saving}
										shortcut={<Kbd action="preview.next" />}
										onClick={() => {
											requestOrRun("next", () => {
												onStep(1)
											})
										}}
									>
										<ChevronRightIcon />
									</TooltipIconButton>
									{slideshowOffered ? (
										<TooltipIconButton
											label={t("previewSlideshowStart")}
											shortcut={<Kbd action="preview.slideshow" />}
											onClick={startSlideshow}
										>
											<PlayIcon />
										</TooltipIconButton>
									) : null}
									{download !== null ? (
										<TooltipIconButton
											label={t("previewDownloadAction")}
											disabled={!isOnline}
											title={!isOnline ? t("common:offlineActionDisabled") : undefined}
											shortcut={<Kbd action="preview.download" />}
											onClick={download}
										>
											<DownloadIcon />
										</TooltipIconButton>
									) : null}
									{hostsAssistant ? <PreviewAssistantToggle /> : null}
									{/* Never for a chat/note embed's fabricated linked-file item (isLinkedEmbedItem). Same
						descriptor list + dropdown renderer the tile/row faces' own ⋯ trigger uses (itemMenu.tsx),
						just with "download" hidden (the button above already covers it) and the two extra
						"direct"-outcome hooks wired into this overlay's own per-slot `saved` override / pager
						housekeeping — see previewMenuHiddenActionIds and the handleMenu* functions (usePreviewItemMenu). */}
									{!isLinkedEmbedItem(driveItem) ? (
										<DropdownMenu
											open={menuOpen}
											onOpenChange={open => {
												setMenuOpen(open && !saving)
											}}
										>
											<Tooltip>
												<TooltipTrigger
													render={
														<DropdownMenuTrigger
															render={
																<Button
																	ref={menuTriggerRef}
																	variant="ghost"
																	size="icon-sm"
																	aria-label={t("drive:driveItemMenuTrigger")}
																	disabled={saving}
																>
																	<MoreHorizontalIcon />
																</Button>
															}
														/>
													}
												/>
												<TooltipContent>
													{t("drive:driveItemMenuTrigger")}
													<Kbd action="preview.openMenu" />
												</TooltipContent>
											</Tooltip>
											<DriveDropdownMenuContent
												item={driveItem}
												variant={variant}
												onItemAction={(kind, _item, startPath) => {
													if (saving) return

													// The move and version-restore dialogs report no outcome, so their echo, whenever it
													// comes, takes the mark; a mark left by a cancelled dialog only quiets a later
													// notice of the same kind.
													if (kind === "move" || kind === "versions") {
														remote.expectOwnChange(driveItem.data.uuid, kind === "move" ? "move" : "restore")
													}

													openMenuDialog(kind, startPath)
												}}
												onFavoriteToggled={handleMenuFavoriteToggled}
												onRestored={handleMenuRestored}
												hiddenActionIds={previewMenuHiddenActionIds(
													hiddenMenuActionIds,
													previewDownloadable(downloadable, variant)
												)}
												compressParentNaming={compressParentNaming}
												shortcuts={PREVIEW_ITEM_SHORTCUTS}
											/>
										</DropdownMenu>
									) : null}
									<Tooltip>
										<TooltipTrigger
											render={
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
											}
										/>
										<TooltipContent>
											{t("common:close")}
											<Kbd action="preview.close" />
										</TooltipContent>
									</Tooltip>
								</>
							)}
						</header>
					)}
					<div className="flex min-h-0 flex-1">
						<div className="relative min-h-0 min-w-0 flex-1">
							<ArchiveListingScope>
								{/* Mid-run (a held arrow key) the slots stepped through show only their header. */}
								{editing !== null ? (
									<PreviewErrorBoundary key={`edit:${editing.uuid}`}>
										<ImageEditor
											source={editing.source}
											info={editing.info}
											locked={saving}
											onDirtyChange={setPreviewDirty}
											onLoadFailed={() => {
												exitImageEdit()
												toast.error(t("previewImageSaveOpenFailed"))
											}}
											saveRef={imageSaveRef}
											commandsRef={imageCommandsRef}
											session={editing.session}
											capabilities={editing.capabilities}
										/>
									</PreviewErrorBoundary>
								) : videoEditing !== null ? (
									<PreviewErrorBoundary key={`videoEdit:${videoEditing.uuid}`}>
										<VideoEditor
											client={videoEditing.client}
											info={videoEditing.info}
											item={driveItem}
											name={name}
											title={
												<DialogPrimitive.Title className="min-w-0">
													<SplitTitle
														text={name}
														tailLength={16}
													/>
												</DialogPrimitive.Title>
											}
											onDirtyChange={setPreviewDirty}
											onCancel={requestExitVideoEdit}
											onExit={exitVideoEdit}
											onSaveStarted={videoSaveStarted}
											onSaveFrame={saveVideoFrame}
											commandsRef={videoCommandsRef}
										/>
									</PreviewErrorBoundary>
								) : !slotSettled ? (
									<PreviewLoading />
								) : (
									<PreviewErrorBoundary key={slotKey}>
										<SlideshowSlot value={slideshow.running ? slideshow.slot : null}>
											<PreviewDownloadableProvider
												downloadable={previewDownloadable(downloadable, variant)}
												onDownload={download}
											>
												<ContentSniffGate
													item={driveItem}
													asText={asText}
													render={() => (
														<PreviewReplaceContext value={replaceInSlot}>
															<PasswordDraftContext value={passwordDraft.draft}>
																<PreviewBody
																	item={driveItem}
																	variant={variant}
																	category={pin?.category}
																	documentKey={currentDocumentKey}
																	editable={slotWritable}
																	renamedReadOnly={renamedReadOnly}
																	neverEditable={
																		!ownsWritableFile(driveItem, variant) || isViewOnlyPdf(driveItem)
																	}
																	locked={saving}
																	onDirtyChange={setPreviewDirty}
																	readAs={readAs}
																	onTextState={state => {
																		if (rawDriveItem !== undefined) {
																			const forUuid = rawDriveItem.data.uuid

																			setTextState(current =>
																				current?.forUuid === forUuid &&
																				current.writable === state.writable &&
																				current.encoding === state.encoding &&
																				current.readEncoding === state.readEncoding
																					? current
																					: { ...state, forUuid }
																			)
																		}
																	}}
																	contentRef={contentRef}
																	spreadsheetRef={spreadsheetRef}
																	docxRef={docxRef}
																	presentationRef={presentationRef}
																	imageRef={imageRef}
																	imagePageRef={imagePageRef}
																	onSave={() => performSaveRef.current()}
																	onAutosave={() => performSaveRef.current(true)}
																	canSaveCopy={canSaveCopyBeside(driveItem, variant)}
																	onOpenFile={opened => {
																		if (rawDriveItem !== undefined) {
																			commitSaved(rawDriveItem.data.uuid, opened)
																		}
																	}}
																/>
															</PasswordDraftContext>
														</PreviewReplaceContext>
													)}
												/>
											</PreviewDownloadableProvider>
										</SlideshowSlot>
									</PreviewErrorBoundary>
								)}
							</ArchiveListingScope>
							{/* On the stage it watches the pointer over. */}
							{slideshow.running ? (
								<SlideshowBar
									slideshow={slideshow}
									subfolders={{ available: subfolders.available, loading: subfolders.loading }}
									onSubfoldersChange={subfolders.setSubfolders}
								/>
							) : null}
						</div>
						{hostsAssistant ? <PreviewAssistantPane /> : null}
					</div>
					{/* Nested confirmation dialog — Base UI supports nesting a dialog inside another normally
					(see versionsDialog.tsx's own identical precedent); this must stay a child of the outer
					Dialog, not a sibling rendered outside it, for the stacked focus-trap/backdrop behavior to
					apply. Shared by close/prev/next — see PreviewDismissIntent — rather than one instance per trigger. */}
					<ConfirmDialog
						open={unsavedPromptOpen(pendingIntent, blocker.status === "blocked", logoutAsks)}
						pending={false}
						title={t("previewUnsavedChangesTitle")}
						body={t("previewUnsavedChangesBody")}
						confirmLabel={t("previewDiscardAction")}
						cancelLabel={t("common:cancel")}
						destructive
						onOpenChange={handleUnsavedOpenChange}
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
											<RemoteFileCompare
												theirs={remoteTheirs}
												mine={mine}
												encoding={slotText?.readEncoding ?? "utf-8"}
											/>
										)
									: undefined
							}
							readMine={() => contentRef.current?.text()}
							pending={remote.pending}
							onKeepMine={remote.keepMine}
							onLoadTheirs={remote.loadTheirs}
							// Without a save source (a read-only viewer) there is nothing to write: not offered.
							onSaveMineAsNew={
								videoEditing !== null
									? () => {
											// The editor's own copy export (an export runs in it, never bytes read here).
											remote.keepMine()
											videoCommandsRef.current?.saveCopy()
										}
									: editable || editing !== null
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
	return (
		<DialogPrimitive.Title className="flex min-w-0 flex-1 font-heading text-sm font-medium">
			<SplitTitle
				text={name}
				tailLength={16}
			/>
		</DialogPrimitive.Title>
	)
}

// A slot's pin and what it was taken for: the document, the item as it stood then, and the verdict.
interface PinnedSlot {
	documentKey: string
	item: DriveItem
	verdict: FileVerdict | undefined
	// Taken while a read still had to tell what the file is: a `.ts` probe (no viewer mounted yet), or a `.dot` the
	// docx viewer reads (a text file is then shown by the text viewer instead).
	awaitingVerdict: boolean
	pin: SlotPin
}
