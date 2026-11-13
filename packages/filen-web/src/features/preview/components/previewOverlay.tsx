import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
	Component,
	type FocusEvent as ReactFocusEvent,
	type KeyboardEvent,
	type ReactNode,
	type RefObject
} from "react"
import { useTranslation } from "react-i18next"
import { useLatestRef } from "@/lib/useLatestRef"
import { useBlocker, type ShouldBlockFn } from "@tanstack/react-router"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import {
	XIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	ChevronDownIcon,
	DownloadIcon,
	SaveIcon,
	MoreHorizontalIcon,
	PencilIcon
} from "lucide-react"
import { toast } from "sonner"
import { asDirectoryOrFile, driveItemMime, isLinkedEmbedItem, type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import {
	extensionOf,
	previewType,
	unprobedTransportStream,
	unsniffedTemplate,
	type PreviewCategory
} from "@/features/drive/lib/preview.logic"
import { recordContentVerdict } from "@/features/drive/lib/contentVerdicts"
import { startDownloads } from "@/features/drive/lib/download"
import {
	canEditImage,
	canEditVideo,
	canSaveCopyBeside,
	editedSaveTimes,
	isEditable,
	isTextCategory,
	isUnresolvableParentError,
	presentationSaveRefusalKey,
	runPreviewSave,
	SaveRefusedError,
	type ImageSaveEdits,
	type PresentationSaveEdits,
	type PresentationSaveSource
} from "@/features/drive/lib/previewSave.logic"
import { currentRootUuid, renameItem, trashItems, deleteItemsPermanently } from "@/features/drive/lib/actions"
import { followClipboardItem } from "@/features/drive/lib/clipboardSync"
import { unshareItems } from "@/features/drive/lib/share/actions"
import { driveListingQueryUpdate } from "@/features/drive/queries/drive"
import { splicePhotoSave } from "@/features/photos/queries/photos"
import { recordOwnSave } from "@/features/preview/lib/ownSaves"
import { imageSaveDeps, writeEditedCopy } from "@/features/preview/lib/editedCopy"
import { ImageEditor } from "@/features/preview/imageEdit/components/imageEditor"
import { enterImageEdit, type ImageEditState } from "@/features/preview/imageEdit/editSession"
import { ORIENTATION_REWRITE_UNAVAILABLE } from "@/features/preview/imageEdit/orientationRewrite"
import { inPlaceFormatByName } from "@/features/preview/imageEdit/lib/targets"
import { inPlaceVideoContainerByName } from "@/features/preview/videoEdit/lib/targets"
import { createVideoEditClient } from "@/features/preview/videoEdit/client"
import { isVideoExportRunning } from "@/features/preview/videoEdit/save"
import { VideoEditor, type VideoEditorCommands } from "@/features/preview/videoEdit/components/videoEditor"
import { VIDEO_CANCEL_ACTION } from "@/features/preview/videoEdit/lib/keys"
import type { VideoSaveTarget } from "@/features/preview/videoEdit/types"
import { knownUnpreviewable, useVideoEditMode } from "@/features/preview/videoEdit/useVideoEditMode"
import type { ImageEditorCommands, ImageExportSource, SaveTarget } from "@/features/preview/imageEdit/types"
import type { ActionOutcome } from "@/lib/actions/outcome"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { DRIVE_DELETE_PERMANENTLY, DRIVE_TRASH, DRIVE_UNSHARE, driveActivity } from "@/features/drive/lib/activity"
import { runBulkActivity, type BulkActivitySpec } from "@/lib/activity/activity"
import { type ActivityKeys } from "@/lib/activity/activity.logic"
import { sdkApi } from "@/lib/sdk/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { IN_EDITORS_AND_FIELDS, useAction } from "@/lib/keymap/useAction"
import { log } from "@/lib/log"
import { useIsOnline } from "@/lib/useIsOnline"
import { holdUnload } from "@/lib/unloadGuard"
import { SplitTitle } from "@/features/preview/components/splitTitle"
import { cn, driveItemName } from "@filen/shared"
import { ImageViewer, RawImageViewer } from "@/features/preview/components/imageViewer"
import type { FileVerdict } from "@filen/shared"
import { MediaViewer } from "@/features/preview/components/mediaViewer"
import { TransportStreamGate } from "@/features/preview/components/transportStreamGate"
import { fileKindVerdict, subscribeFileKindVerdicts } from "@/features/drive/lib/fileKindVerdicts"
import { DocxViewer } from "@/features/preview/components/docxViewer"
import type { DocxSaveSource } from "@/features/preview/components/docxEditor"
import { MarkdownViewer } from "@/features/preview/components/markdownViewer"
import { PdfViewer } from "@/features/preview/components/pdfViewer"
import { TextViewer } from "@/features/preview/components/textViewer"
import type { SpreadsheetSaveSource } from "@/features/spreadsheet/save/sheetSave.logic"
import { SheetViewer } from "@/features/spreadsheet/sheetViewer"
import { PresentationViewer } from "@/features/presentation/components/presentationViewer"
import { presentationSaveFormat } from "@/features/presentation/lib/fileKind"
import { RemoteFileCompare } from "@/features/preview/components/remoteCompare"
import { ArchiveBrowser } from "@/features/archive/components/archiveBrowser"
import { ArchiveListingScope } from "@/features/archive/components/archiveListingScope"
import { PreviewDownloadableProvider } from "@/features/preview/lib/accessMode"
import { PreviewReplaceContext, type PreviewReplaceMake } from "@/features/preview/lib/previewReplace"
import { PasswordDraft, PasswordDraftContext } from "@/features/preview/lib/passwordDraft"
import { stableUuidOf } from "@/features/drive/store/useDriveClipboardStore"
import { PreviewLoading } from "@/features/preview/components/previewErrorState"
import { useSettledSlot } from "@/features/preview/hooks/useSettledSlot"
import {
	isTextEditingTarget,
	previewDownloadable,
	previewNavigationUnmountsOverlay,
	previewMenuHiddenActionIds,
	resolveUnsavedConfirm,
	slotPinSource,
	unsavedPromptOpen,
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
import { clearPreviewCache, loadPreviewBytes } from "@/features/preview/lib/previewCache"
import { usePreviewCacheScope } from "@/features/preview/lib/accessMode"
import { spreadsheetSaveFormat } from "@/features/spreadsheet/lib/fileKind"
import { usePreviewRemoteChanges, type PreviewEdits } from "@/features/preview/hooks/usePreviewRemoteChanges"
import { RemoteChangeDialog } from "@/features/preview/components/remoteChangeDialog"
import { DriveDropdownMenuContent } from "@/features/drive/components/itemMenu"
import { toggleItemFavorite } from "@/features/drive/lib/favorite"
import {
	applyOfflineGate,
	driveItemActions,
	type ItemActionDialogKind,
	type ItemActionId
} from "@/features/drive/components/itemMenu.logic"
import { type ParentNaming } from "@/features/drive/lib/archiveTargets"
import { MoveTargetDialog } from "@/features/drive/components/moveTargetDialog"
import { ItemDialog, RenameItemDialog, TrashConfirmDialog } from "@/features/drive/components/itemDialogs"
import { Button } from "@/components/ui/button"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Kbd } from "@/lib/keymap/kbd"
import { Spinner } from "@/components/ui/spinner"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { dialogLayerOf, isAnyMenuOpen } from "@/lib/keymap/dialogGuard"

const IS_MAC = isMacPlatform()
// The two actions an Escape the dialog dismisses on may be: closing, and leaving the image editor.
const CLOSE: ActionDef | undefined = PREVIEW_OVERLAY_ACTIONS.find(def => def.id === "preview.close")
const IMAGE_CANCEL: ActionDef | undefined = IMAGE_EDITOR_ACTIONS.find(def => def.id === "preview.imageCancel")

// Module scope, not an inline arrow: useBlocker's registration effect lists shouldBlockFn in its own
// deps, so a per-render identity would unregister/re-register the history blocker on every render.
const blockWhenLeavingRoute: ShouldBlockFn = ({ current, next }) => previewNavigationUnmountsOverlay(current.routeId, next.routeId)

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
	compressParentNaming,
	onSourcesDisposing,
	downloadable: downloadableProp,
	asText: asTextProp
}: PreviewOverlayProps) {
	// Not a parameter default: the React Compiler skips a component that has one.
	const downloadable = downloadableProp !== false
	const asText = asTextProp === true
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
	// The Word document editor's, likewise (written by its lossless writer when a save asks).
	const docxRef = useRef<DocxSaveSource | null>(null)
	// The presentation editor's: a save its worker streams to the upload over a port (the deck is never whole here).
	const presentationRef = useRef<PresentationSaveSource | null>(null)
	// The image viewer's <img>, whose decoded pixels the image editor starts from; and the open image editor's export
	// (what a save writes) and commands (the header's Revert).
	const imageRef = useRef<HTMLImageElement | null>(null)
	const imageSaveRef = useRef<ImageExportSource | null>(null)
	const imageCommandsRef = useRef<ImageEditorCommands | null>(null)
	// The open video editor's commands (Mod+S opens its Save popover; the remote-change dialog's copy is its export).
	const videoCommandsRef = useRef<VideoEditorCommands | null>(null)
	const cacheScope = usePreviewCacheScope()

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

		const edits = await readSaveEdits(false)

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
	// Not component state: the sign-out path is a plain lib function and has to be able to read this
	// same bit (see usePreviewUnsavedGuard). Boolean-collapsed selector, so the overlay still re-renders
	// on the dirty EDGE only.
	const dirty = usePreviewUnsavedGuardStore(state => state.dirty)
	const logoutRequest = usePreviewUnsavedGuardStore(state => state.logoutRequest)
	const [saving, setSaving] = useState(false)
	const [pendingIntent, setPendingIntent] = useState<PreviewDismissIntent | null>(null)
	// What a "replace" intent runs once the edits are discarded; kept through the prompt's close (WebKit can report
	// it before the confirm), cleared by the confirm and replaced by the next request.
	const pendingReplaceRef = useRef<(() => void) | null>(null)
	// Which secondary dialog the header's item menu (below) currently has open, if any — a single slot
	// since only ever one item (the currently-viewed one) is ever being acted on from in here, unlike
	// useDriveDialogHost's own activeDialog which also has to carry a whole bulk-selection items[].
	// "color" and "openAsText" are part of the shared ItemActionDialogKind union but unreachable here —
	// driveItemActions only ever offers Color for a directory, which never opens this overlay, and Open
	// as text only to a surface that opens items (this header menu has its item open already).
	const [menuDialogKind, setMenuDialogKind] = useState<ItemActionDialogKind | null>(null)
	const [menuPending, setMenuPending] = useState(false)
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
	// A `.ts` waiting on its probe (TransportStreamGate) has no viewer yet: the verdict that ends the wait
	// takes it once more, by the name it was pinned under; so does a `.dot` the docx viewer found to be text. A
	// verdict landing after a viewer mounted (an audio-only `.webm` found out mid-playback) leaves it be until the
	// slot is opened again.
	const streamVerdict = useSyncExternalStore(subscribeFileKindVerdicts, () =>
		driveItem === undefined ? undefined : fileKindVerdict(driveItem.data.uuid)
	)
	const pinFrom = slotPinSource(pinned, { documentKey: currentDocumentKey, item: driveItem, verdict: streamVerdict })
	const derivedPin = pinFrom === null ? null : slotPin(pinFrom, variant, asText)
	const pin = driveItem === undefined ? null : (derivedPin ?? pinned?.pin ?? null)

	if (pinFrom !== null && derivedPin !== null) {
		setPinned({
			documentKey: currentDocumentKey,
			item: pinFrom,
			verdict: streamVerdict,
			awaitingVerdict: !asText && (unprobedTransportStream(pinFrom) || unsniffedTemplate(pinFrom)),
			pin: derivedPin
		})
	}

	// Compared against the FROZEN pre-save uuid (rawDriveItem), never the possibly-rotated override's uuid — see
	// `saved`'s own comment on why that's the stable key. A rename to another format leaves the open
	// viewer read-only: what it holds would be saved under a name that says otherwise.
	const editable =
		rawDriveItem !== undefined &&
		driveItem !== undefined &&
		pin !== null &&
		!asText &&
		isEditable(driveItem, variant) &&
		saveFormat(driveItem) === pin.format &&
		lockedReadOnly?.forUuid !== rawDriveItem.data.uuid
	// Read-only only because a rename changed the format the open edits would be saved in.
	const renamedReadOnly = driveItem !== undefined && pin?.editable === true && saveFormat(driveItem) !== pin.format
	// The image editor's session, for the slot and the version it opened on: another file on screen (a newer version
	// loaded, the slot gone) leaves edit mode, and the effect below ends the session.
	const [editState, setEditState] = useState<ImageEditState | null>(null)
	const editing =
		editState !== null && rawDriveItem?.data.uuid === editState.frozenUuid && driveItem?.data.uuid === editState.uuid ? editState : null

	if (editState !== null && editing === null) {
		setEditState(null)
	}

	// Opening the editor (sniffing, the worker's probe, the source's decode) is under way.
	const [enteringEdit, setEnteringEdit] = useState(false)
	const enterAbortRef = useRef<AbortController | null>(null)
	// The slot shows an image the editor can open (saved in place, or as a copy for a format it cannot write).
	const imageEditable = driveItem !== undefined && !asText && pin?.category === "image" && canEditImage(driveItem, variant)
	// The header's Save: a new version where the format is written in place and the slot may be, else the copy.
	const imagePrimaryTarget: SaveTarget | null =
		editing === null ? null : editing.targets.primary.kind === "inPlace" && editable ? editing.targets.primary : copyTargetOf(editing)

	// The video editor's session, for the slot and the version it opened on, as the image editor's: another file on
	// screen leaves video edit mode (the effect below), which ends its client.
	const videoMode = useVideoEditMode(item => createVideoEditClient({ item }))
	const videoState = videoMode.state
	const videoEditing =
		videoState !== null && rawDriveItem?.data.uuid === videoState.frozenUuid && driveItem?.data.uuid === videoState.uuid
			? videoState
			: null
	const videoStale = videoState !== null && videoEditing === null
	const exitVideoMode = videoMode.exit

	useEffect(() => {
		if (videoStale) {
			exitVideoMode()
		}
	}, [videoStale, exitVideoMode])

	// The slot shows a video the editor may open: in the user's own drive, in a container the export reads, and not
	// already found to have no picture this browser shows.
	const videoEditable =
		driveItem !== undefined &&
		!asText &&
		pin?.category === "video" &&
		canEditVideo(driveItem, variant) &&
		!knownUnpreviewable(driveItem.data.uuid)
	// Either editor is open: the viewer's header, keys and saves step aside.
	const anyEditing = editing !== null || videoEditing !== null

	// Leaving edit mode, or the overlay, ends the session: the render worker's idle teardown starts then.
	useEffect(() => {
		if (editState === null) {
			return
		}

		const state = editState

		return () => {
			state.release()
		}
	}, [editState])

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

	// Opens the image on screen in the editor, or says why it cannot. Not while anything else is under way or asked.
	function startImageEdit(): void {
		const item = driveItem
		const raw = rawDriveItem

		if (
			!imageEditable ||
			item === undefined ||
			raw === undefined ||
			anyEditing ||
			enteringEdit ||
			saving ||
			remote.prompt !== null ||
			pendingIntent !== null ||
			menuDialogKind !== null
		) {
			return
		}

		const controller = new AbortController()
		const slot = `${raw.data.uuid}/${item.data.uuid}`

		enterAbortRef.current?.abort()
		enterAbortRef.current = controller
		setEnteringEdit(true)

		void enterImageEdit({ item, frozenUuid: raw.data.uuid, cacheScope, image: imageRef.current, signal: controller.signal }).then(
			outcome => {
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
			}
		)
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

		if (
			!videoEditable ||
			item === undefined ||
			raw === undefined ||
			anyEditing ||
			videoMode.entering ||
			enteringEdit ||
			saving ||
			remote.prompt !== null ||
			pendingIntent !== null ||
			menuDialogKind !== null
		) {
			return
		}

		// A save of this video still running (in an editor gone to the background, or a transfer): a second one would
		// race it for the same name or version, so the editor waits until it ends.
		if (isVideoExportRunning(stableUuidOf(item) ?? item.data.uuid)) {
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
	async function saveVideoFrame(blob: Blob, extension: "jpg"): Promise<string> {
		const item = driveItem

		if (item === undefined) {
			throw new Error("no file on screen")
		}

		const written = await writeEditedCopy(item, blob, extension, number =>
			number <= 1 ? t("previewImageSaveCopySuffix") : t("previewImageSaveCopySuffixNumbered", { number })
		)

		if (written === null || written.outcome.status === "error") {
			throw new Error(written?.outcome.status === "error" ? written.outcome.dto.message : "not a file")
		}

		recordOwnSave(written.outcome.item.data.uuid)

		return written.name
	}

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

	// The menu's confirm dialog shows the run, so only its result toasts.
	async function runMenuActivity(spec: BulkActivitySpec<DriveItem>): Promise<void> {
		setMenuPending(true)
		await runBulkActivity({ ...spec, showRunning: false })
		setMenuPending(false)
		setMenuDialogKind(null)
	}

	async function removeCurrentItem(remove: BulkActivitySpec<DriveItem>["run"], keys: ActivityKeys): Promise<void> {
		if (driveItem === undefined || rawDriveItem === undefined) {
			return
		}

		const frozenUuid = rawDriveItem.data.uuid

		await runMenuActivity(
			driveActivity(
				[driveItem],
				keys,
				async (targets, onSettled, report) => {
					// Its echo can beat the response back: the user's own removal, not one made elsewhere.
					remote.expectOwnChange(driveItem.data.uuid, "remove")

					try {
						return await remove(targets, onSettled, report)
					} finally {
						remote.forgetOwnChange(driveItem.data.uuid)
					}
				},
				{
					onDone: outcome => {
						if (outcome.succeeded.length > 0) {
							onItemRemoved(frozenUuid)
						}
					}
				}
			)
		)
	}

	// Mirrors new mobile's removeShare/stopSharing dismissOnSuccess: isPreview === true — closes the
	// WHOLE preview immediately on success rather than stepping to a neighbour (unlike trash/delete
	// above), since new mobile's own gallery has no driveItemRemoved-driven "step past it" behavior for
	// this one.
	async function handleMenuUnshare(): Promise<void> {
		if (driveItem === undefined) {
			return
		}

		// Only this receiver's row leaves the listing, and no echo prunes a selected row the way trash and
		// delete echoes do.
		await runMenuActivity(
			driveActivity([driveItem], DRIVE_UNSHARE, (targets, onSettled) => unshareItems(targets, variant, onSettled), {
				prune: "row",
				onDone: outcome => {
					if (outcome.succeeded.length > 0 && mountedRef.current) {
						onClose()
					}
				}
			})
		)
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

	function closeMenuDialog(): void {
		setMenuDialogKind(null)
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
					<RenameItemDialog
						item={driveItem}
						pending={menuPending}
						onClose={closeMenuDialog}
						onSubmit={value => {
							void handleMenuRename(value)
						}}
					/>
				)
			case "move":
				return (
					<MoveTargetDialog
						items={[driveItem]}
						onClose={closeMenuDialog}
					/>
				)
			case "copy":
			case "versions":
			case "info":
			case "link":
			case "share":
			case "compress":
			case "extract":
			case "extractTo":
				return (
					<ItemDialog
						kind={menuDialogKind}
						items={[driveItem]}
						variant={variant}
						onClose={closeMenuDialog}
						onSourcesDisposing={onSourcesDisposing}
						compressParentNaming={compressParentNaming}
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
								closeMenuDialog()
							}
						}}
						onConfirm={() => {
							void handleMenuUnshare()
						}}
					/>
				)
			case "trash":
				return (
					<TrashConfirmDialog
						count={1}
						pending={menuPending}
						onClose={closeMenuDialog}
						onConfirm={() => {
							void removeCurrentItem(trashItems, DRIVE_TRASH)
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
								closeMenuDialog()
							}
						}}
						onConfirm={() => {
							void removeCurrentItem(deleteItemsPermanently, DRIVE_DELETE_PERMANENTLY)
						}}
					/>
				)
			case "color":
			case "openAsText":
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
	}, [slotKey])

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

	// The one write path: encode -> upload -> patch listing -> re-key onto the rotated uuid (success), or
	// a LABEL-FIRST toast (failure) — read-only lockdown is reserved for the ONE failure class retrying
	// can never fix (isUnresolvableParentError, see previewSave.logic.ts's own comment on why); every
	// other failure leaves the buffer editable+dirty for a retry. `dirty` is reset explicitly on SUCCESS
	// below — a new `item.data.uuid` re-keys PreviewBody and the remounted viewer re-seeds a fresh
	// editor's own buffer, but a slot that mounts NO editor (markdown returns in rendered mode) would
	// otherwise never report the buffer clean. A FAILURE never remounts anything, so the buffer (and its
	// dirty bit) simply survives untouched, which is what keeps the typed content visible and the
	// close/nav prompt still armed.
	//
	// True when a save started; false when one could not start now (nothing to save, one in flight, a dialog
	// open...), which an idle autosave tries again later.
	function performSave(auto = false): boolean {
		// In edit mode a save is the image's own, never an autosave.
		if (editing !== null) {
			return !auto && imagePrimaryTarget !== null && saveImage(imagePrimaryTarget)
		}

		// The video editor's Save popover says what the export will do before anything runs.
		if (videoEditing !== null) {
			if (!auto) {
				videoCommandsRef.current?.openSave()
			}

			return false
		}

		// Locals, not the outer `driveItem`/`rawDriveItem` directly — this closure runs asynchronously, well
		// after this render's narrowing; re-binding here gives the guard below its own, freshly-narrowable copy.
		const targetItem = driveItem
		const targetRawItem = rawDriveItem

		// Nor under a dialog: over the remote-change question it would decide it for the user, and a save
		// from the unsaved-changes prompt or a menu dialog would act behind it.
		if (
			!editable ||
			!dirty ||
			targetItem === undefined ||
			targetRawItem === undefined ||
			remote.prompt !== null ||
			unsavedPromptOpen(pendingIntent, blocker.status === "blocked", logoutRequest !== null) ||
			menuDialogKind !== null
		) {
			return false
		}

		// One in flight: this one runs once it settles, if the file is still dirty then (saveAgain below).
		if (saving) {
			saveAgainRef.current = (saveAgainRef.current ?? true) && auto

			return false
		}

		setSaving(true)
		remote.saveStarted()
		void saveNow(targetItem, targetRawItem, auto)

		return true
	}

	async function saveNow(targetItem: DriveItem, targetRawItem: DriveItem, auto: boolean): Promise<void> {
		// An editor that refused to write its file (its own check failed) says why.
		const edits = await readSaveEdits(auto).catch((e: unknown) => {
			if (e instanceof SaveRefusedError) {
				return e
			}

			log.error("preview", "reading the edits to save failed", e)

			return null
		})

		if (edits === null || edits instanceof SaveRefusedError) {
			setSaving(false)
			remote.saveSettled(null)

			if (edits === null) {
				toast.error(t("previewSaveFailed"))
			} else if (!edits.silent) {
				const action = edits.action

				toast.error(t(edits.messageKey), {
					...(action === undefined ? {} : { action: { label: t(action.labelKey), onClick: action.run }, duration: Infinity })
				})
			}

			return
		}

		if ("kind" in edits) {
			await savePresentation(edits, targetItem, targetRawItem)

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
			// The remounted viewer re-seeds this itself when it mounts an editor; markdown returns in
			// RENDERED mode and mounts none, so a stale buffer would otherwise stay readable to a second save.
			dropPreviewBuffer(contentRef)
		}

		// Last, so a version saved elsewhere after this one is judged against it.
		remote.saveSettled(outcome.item)
	}

	// The image editor's saves, with performSave's guards: a new version of the file (in place) or a copy beside it.
	// Nothing to save until the image was edited.
	function saveImage(target: SaveTarget): boolean {
		const state = editing
		const targetItem = driveItem
		const targetRawItem = rawDriveItem

		if (
			state === null ||
			targetItem === undefined ||
			targetRawItem === undefined ||
			!dirty ||
			saving ||
			(target.kind === "inPlace" && !editable) ||
			remote.prompt !== null ||
			unsavedPromptOpen(pendingIntent, blocker.status === "blocked", logoutRequest !== null) ||
			menuDialogKind !== null
		) {
			return false
		}

		setSaving(true)
		remote.saveStarted()

		if (target.kind === "inPlace") {
			void saveImageInPlace(state, targetItem, targetRawItem, target)
		} else {
			void saveImageCopy(targetItem, targetRawItem, target)
		}

		return true
	}

	// A new version of the file: shown in the slot as any save is, edit mode left once it landed. A failure keeps the
	// editor and its edits for another try (or a copy, where the file turned out unwritable).
	async function saveImageInPlace(
		state: ImageEditState,
		targetItem: DriveItem,
		targetRawItem: DriveItem,
		target: Extract<SaveTarget, { kind: "inPlace" }>
	): Promise<void> {
		const written = await writeImageInPlace(targetItem, target, imageSaveRef.current).catch((e: unknown) => {
			log.error("preview", "saving the edited image failed", e)

			return null
		})

		if (written === null) {
			setSaving(false)
			remote.saveSettled(null)
			toast.error(t("previewSaveFailed"))

			return
		}

		const outcome = written.outcome

		if (outcome.status === "error") {
			setSaving(false)
			remote.saveSettled(null)
			toast.error(errorLabel(outcome.dto))

			if (isUnresolvableParentError(outcome.dto)) {
				setLockedReadOnly({ forUuid: targetRawItem.data.uuid })
				toast.warning(t("previewReadOnlyAfterSaveFailure"))
			}

			return
		}

		// A slot shown from its held bytes reopens on the saved version from memory; a streamed one streams it.
		if (state.buffered && written.blob !== null) {
			await seedSavedImage(cacheScope, outcome.item.data.uuid, written.blob)
		}

		setSaving(false)
		commitSaved(targetRawItem.data.uuid, outcome.item, true)
		followClipboardItem(outcome.item, targetItem.data.uuid)
		splicePhotoSave(targetItem.data.uuid, outcome.item, "replace")
		exitImageEdit()
		remote.saveSettled(outcome.item)
	}

	// A copy beside the file: never shown in the slot nor followed by the clipboard (the file itself is unchanged);
	// its toast offers to open it.
	async function saveImageCopy(
		targetItem: DriveItem,
		targetRawItem: DriveItem,
		target: Extract<SaveTarget, { kind: "copy" }>
	): Promise<void> {
		const written = await writeImageCopy(targetItem, target, imageSaveRef.current, number =>
			number <= 1 ? t("previewImageSaveCopySuffix") : t("previewImageSaveCopySuffixNumbered", { number })
		).catch((e: unknown) => {
			log.error("preview", "saving the edited image as a copy failed", e)

			return null
		})

		setSaving(false)

		if (written === null) {
			remote.saveSettled(null)
			toast.error(t("previewSaveFailed"))

			return
		}

		if (written.outcome.status === "error") {
			remote.saveSettled(null)
			toast.error(errorLabel(written.outcome.dto))

			return
		}

		const copy = written.outcome.item
		const frozenUuid = targetRawItem.data.uuid
		const slot = `${frozenUuid}/${targetItem.data.uuid}`

		recordOwnSave(copy.data.uuid)
		splicePhotoSave(targetItem.data.uuid, copy, "beside")
		// Left before the newer versions held through the save are judged: nothing unsaved is asked about.
		exitImageEdit()
		remote.saveSettled(null)
		toast.success(t("previewImageSaveSavedAsCopy", { name: written.name }), {
			action: {
				label: t("previewImageSaveOpenCopyAction"),
				onClick: () => {
					// Only into the slot it was saved from, still on screen, with nothing unsaved there.
					if (mountedRef.current && currentSlotRef.current === slot) {
						openSavedCopyRef.current(frozenUuid, copy)
					}
				}
			}
		})
	}

	// A deck's save: the session streams the package to the upload over a port while it reads the old file; once the
	// upload made the new file, the session moves onto it (commit), so a drive without versioning deleting the old one
	// never leaves it reading a file that is gone. The editor stays mounted (bodyKey) with its history.
	async function savePresentation(edits: PresentationSaveEdits, targetItem: DriveItem, targetRawItem: DriveItem): Promise<void> {
		// No upload at all unless the session is going to write (an untouched or fully undone deck, a refusal).
		const writes = await Promise.race([
			edits.announced,
			edits.result.then(
				() => false,
				() => false
			)
		])

		if (!writes) {
			edits.port.close()

			const result = await edits.result.catch((e: unknown) => {
				log.error("preview", "the presentation save failed", e)

				return { kind: "refused" as const, reason: "failed" as const }
			})

			setSaving(false)
			remote.saveSettled(null)

			if (result.kind === "refused") {
				toast.error(t(presentationSaveRefusalKey(result.reason)))
			}

			return
		}

		const upload = runPreviewSave(
			{
				uploadFileBytes: (parentUuid, data, name, mime) => sdkApi.uploadFileBytes(parentUuid, data, name, mime),
				uploadFileFromPort: (parentUuid, port, name, mime, size) => sdkApi.uploadFileFromPort(parentUuid, name, mime, port, size),
				patchListing: driveListingQueryUpdate,
				rootUuid: currentRootUuid()
			},
			{ item: targetItem, content: { port: edits.port } }
		)
		const result = await edits.result.catch((e: unknown) => {
			log.error("preview", "the presentation save failed", e)

			return { kind: "refused" as const, reason: "failed" as const }
		})

		// A refusal is told at once and the upload behind the port ended (no new version), never waited for: an upload
		// whose reader missed the abort would never settle.
		if (result.kind === "refused") {
			edits.port.close()
			void upload.catch(() => undefined)
			setSaving(false)
			remote.saveSettled(null)
			toast.error(t(presentationSaveRefusalKey(result.reason)))

			return
		}

		const outcome = await upload

		// Nothing to save (every edit undone): the upload was ended without a file.
		if (result.kind === "unchanged") {
			setSaving(false)
			remote.saveSettled(null)

			return
		}

		if (outcome.status === "error") {
			setSaving(false)
			remote.saveSettled(null)
			toast.error(errorLabel(outcome.dto))

			if (isUnresolvableParentError(outcome.dto)) {
				setLockedReadOnly({ forUuid: targetRawItem.data.uuid })
				toast.warning(t("previewReadOnlyAfterSaveFailure"))
			}

			return
		}

		// A written save is always committed: the session holds its reads of the old file until then.
		await edits.commit(outcome.item).catch((e: unknown) => {
			log.error("preview", "moving the presentation onto its saved file failed", e)
		})
		setSaving(false)
		commitSaved(targetRawItem.data.uuid, outcome.item, true)
		followClipboardItem(outcome.item, targetItem.data.uuid)
		remote.saveSettled(outcome.item)
	}

	// What a save uploads, and for a spreadsheet the call that marks that version saved once it landed; for a deck,
	// the save its session streams.
	async function readSaveEdits(
		auto: boolean
	): Promise<{ bytes: Uint8Array; commit: (() => void) | null } | PresentationSaveEdits | null> {
		if (presentationRef.current !== null) {
			return await presentationRef.current({ auto })
		}

		if (spreadsheetRef.current !== null) {
			return await spreadsheetRef.current()
		}

		if (docxRef.current !== null) {
			return await docxRef.current({ auto })
		}

		const text = contentRef.current?.()

		return text === undefined ? null : { bytes: new TextEncoder().encode(text), commit: null }
	}

	// Idle autosave (the Word document editor's, the spreadsheet editor's) runs the same save, with its guards, as it
	// stands now.
	const performSaveRef = useLatestRef(performSave)
	// A saved copy's Open, as things stand when it is clicked: not over edits or a save.
	const openSavedCopyRef = useLatestRef((frozenUuid: string, copy: DriveItem) => {
		if (!anyEditing && !dirty && !saving) {
			commitSaved(frozenUuid, copy)
		}
	})
	const startImageEditRef = useLatestRef(startImageEdit)
	const startVideoEditRef = useLatestRef(startVideoEdit)
	// A video export's end, as things stand when it comes (the export may outlive the editor that started it).
	const videoSaveSettledRef = useLatestRef(videoSaveSettled)
	// A save asked for while one was in flight (a second Mod+S, an autosave meeting one), and whether only autosaves
	// asked: run once that one settles and the file is still dirty, so no request is dropped with the deck left dirty.
	const saveAgainRef = useRef<boolean | null>(null)

	useEffect(() => {
		const auto = saveAgainRef.current

		if (saving || auto === null) {
			return
		}

		saveAgainRef.current = null

		if (dirty) {
			performSaveRef.current(auto)
		}
	}, [saving, dirty, performSaveRef])

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

		if (escape && !pressed(CLOSE)) {
			details.cancel()

			return
		}

		if (!next) {
			requestOrRun("close", onClose)
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

		// A focused media scrubber wins over the pager — native seek expectation (see isMediaTarget
		// above). A focused CodeMirror surface wins too — its own arrow bindings move the cursor/
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

		// A chat's or a note's linked file has no menu (isLinkedEmbedItem), so no menu keys either.
		if (isLinkedEmbedItem(driveItem) || saving || menuDialogKind !== null) {
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

		setMenuDialogKind(kind)
	}

	function handleUnsavedConfirm(): void {
		// Never while a save is in flight: what it writes would still be uploaded after the user discarded it.
		if (saving) {
			return
		}

		const actions = resolveUnsavedConfirm(pendingIntent, blocker.status === "blocked", logoutAsks)

		setPendingIntent(null)
		// The buffer is gone by the user's own choice: drop the dirty bit and the stale content with it.
		// The slot-change effect above cannot cover this one — a discarded "close" answer changes no slot,
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
					{videoEditing !== null ? null : (
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
											disabled={videoMode.entering || saving}
											shortcut={<Kbd action="preview.editVideo" />}
											onClick={startVideoEdit}
										>
											{videoMode.entering ? <Spinner className="size-4" /> : <PencilIcon />}
										</TooltipIconButton>
									) : null}
									{editable && dirty ? (
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
									{/* Never for a chat/note embed's fabricated linked-file item (isLinkedEmbedItem). Same
						descriptor list + dropdown renderer the tile/row faces' own ⋯ trigger uses (itemMenu.tsx),
						just with "download" hidden (the button above already covers it) and the two extra
						"direct"-outcome hooks wired into this overlay's own per-slot `saved` override / pager
						housekeeping — see previewMenuHiddenActionIds and the handleMenu* functions above. */}
									{!isLinkedEmbedItem(driveItem) ? (
										<DropdownMenu>
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
					<div className="min-h-0 flex-1">
						<ArchiveListingScope>
							{/* Mid-run (a held arrow key) the slots stepped through show only their header. */}
							{editing !== null ? (
								<PreviewErrorBoundary key={`edit:${editing.uuid}`}>
									<ImageEditor
										source={editing.source}
										info={editing.info}
										locked={saving}
										onDirtyChange={setPreviewDirty}
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
									<PreviewDownloadableProvider
										downloadable={previewDownloadable(downloadable, variant)}
										onDownload={download}
									>
										<TransportStreamGate
											item={driveItem}
											render={() => (
												<PreviewReplaceContext value={replaceInSlot}>
													<PasswordDraftContext value={passwordDraft.draft}>
														<PreviewBody
															item={driveItem}
															variant={variant}
															category={pin?.category}
															documentKey={currentDocumentKey}
															editable={editable}
															renamedReadOnly={renamedReadOnly}
															neverEditable={variant !== "drive"}
															asText={asText}
															locked={saving}
															onDirtyChange={setPreviewDirty}
															contentRef={contentRef}
															spreadsheetRef={spreadsheetRef}
															docxRef={docxRef}
															presentationRef={presentationRef}
															imageRef={imageRef}
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
								</PreviewErrorBoundary>
							)}
						</ArchiveListingScope>
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
											<RemoteFileCompare
												theirs={remoteTheirs}
												mine={mine}
											/>
										)
									: undefined
							}
							readMine={() => contentRef.current?.()}
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

// The edited image as a copy in the format saveTargets chose for one.
function copyTargetOf(state: ImageEditState): Extract<SaveTarget, { kind: "copy" }> {
	const copy = state.targets.copy

	if (copy.kind === "copy") {
		return copy
	}

	return state.info.hasAlpha
		? { kind: "copy", mime: "image/png", extension: "png" }
		: { kind: "copy", mime: "image/jpeg", extension: "jpg" }
}

function imageSaveLabelKey(
	target: SaveTarget
): "previewImageSaveSaveAction" | "previewImageSaveAsPngCopyAction" | "previewImageSaveAsJpegCopyAction" {
	if (target.kind === "inPlace") {
		return "previewImageSaveSaveAction"
	}

	return target.mime === "image/png" ? "previewImageSaveAsPngCopyAction" : "previewImageSaveAsJpegCopyAction"
}

type ImageExport = Awaited<ReturnType<ImageExportSource>>

async function exportImage(source: ImageExportSource | null, target: SaveTarget): Promise<ImageExport | null> {
	if (source === null) {
		return null
	}

	return await source(target).catch((e: unknown) => {
		log.error("preview", "exporting the edited image failed", e)

		return null
	})
}

function rewriteUnavailable(dto: ErrorDTO): boolean {
	return dto.species === "plain" && dto.message.startsWith(ORIENTATION_REWRITE_UNAVAILABLE)
}

// A new version of the file in its own format: the export, or for a JPEG only turned or flipped its Orientation
// rewritten in the file itself, re-encoded after all when that cannot be done. `blob`: what was uploaded, if a Blob.
// Null when there was nothing to upload (the export failed).
async function writeImageInPlace(
	item: DriveItem,
	target: Extract<SaveTarget, { kind: "inPlace" }>,
	source: ImageExportSource | null
): Promise<{ outcome: ActionOutcome<DriveItem>; blob: Blob | null } | null> {
	const exported = await exportImage(source, target)

	if (exported === null) {
		return null
	}

	const times = editedSaveTimes(item, Date.now())
	const deps = imageSaveDeps()

	if (exported.geometryOnly !== null) {
		const rewritten = await runPreviewSave(deps, {
			item,
			content: { orientation: exported.geometryOnly.orientation },
			times,
			mime: target.mime
		})

		if (rewritten.status === "success" || !rewriteUnavailable(rewritten.dto)) {
			return { outcome: rewritten, blob: null }
		}

		// The same JPEG encode a copy gets, uploaded in place.
		const reencoded = (await exportImage(source, { kind: "copy", mime: "image/jpeg", extension: "jpg" }))?.blob ?? null

		if (reencoded === null) {
			return null
		}

		return { outcome: await runPreviewSave(deps, { item, content: { blob: reencoded }, times, mime: target.mime }), blob: reencoded }
	}

	const blob = exported.blob

	if (blob === null) {
		return null
	}

	return { outcome: await runPreviewSave(deps, { item, content: { blob }, times, mime: target.mime }), blob }
}

// A copy beside the file, named "photo (edited).jpg" (or the first such name free) from one read of the directory's
// names, and typed by the SDK from that name.
async function writeImageCopy(
	item: DriveItem,
	target: Extract<SaveTarget, { kind: "copy" }>,
	source: ImageExportSource | null,
	suffix: (number: number) => string
): Promise<{ outcome: ActionOutcome<DriveItem>; name: string } | null> {
	const blob = (await exportImage(source, target))?.blob ?? null

	return blob === null ? null : await writeEditedCopy(item, blob, target.extension, suffix)
}

// The edited image for the remote-change dialog's "save mine as new": as the header's Save would write it, or
// re-encoded where that is the lossless rewrite of the file itself (a new file has no file to rewrite).
async function readImageEdits(state: ImageEditState, source: ImageExportSource | null, inPlace: boolean): Promise<ImageSaveEdits | null> {
	const target = inPlace && state.targets.primary.kind === "inPlace" ? state.targets.primary : copyTargetOf(state)
	const exported = await exportImage(source, target)

	if (exported === null) {
		return null
	}

	if (exported.blob !== null) {
		return {
			kind: "blob",
			blob: exported.blob,
			extension: target.kind === "copy" && target.mime !== state.info.mime ? target.extension : null
		}
	}

	const copy = copyTargetOf(state)
	const encoded = (await exportImage(source, copy))?.blob ?? null

	if (encoded === null) {
		return null
	}

	return { kind: "blob", blob: encoded, extension: copy.mime !== state.info.mime ? copy.extension : null }
}

// Keeps a saved image's bytes for the preview of the version it made, read from the Blob that was uploaded.
async function seedSavedImage(cacheScope: string | null, uuid: string, blob: Blob): Promise<void> {
	await loadPreviewBytes(cacheScope, uuid, blob.size, async () => new Uint8Array(await blob.arrayBuffer())).catch((e: unknown) => {
		log.warn("preview", "keeping the saved image's bytes failed", e)
	})
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

// What a drive slot renders with, and the format its edits are saved in: fixed when the slot opens.
interface SlotPin {
	category: PreviewCategory
	format: string
	// Whether the slot was editable as it mounted.
	editable: boolean
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

// The format edits are written in: text for every text category, the file kind for a spreadsheet (its
// writer follows the kind it opened as, the same judgement the grid's own rename note makes), and for a Word
// document its extension (the writer keeps the content type the file opened with: a document, a template,
// macro-enabled or not; a rename to another of them would save one under a name that says another).
function saveFormat(item: DriveItem): string {
	const category = previewType(item)

	if (isTextCategory(category)) {
		return "text"
	}

	if (category === "docx") {
		return `docx:${extensionOf(driveItemName(item))}`
	}

	// An image saves in place in the format its name says (a rename to another leaves the editor saving copies only).
	if (category === "image") {
		return `image:${inPlaceFormatByName(driveItemName(item)) ?? ""}`
	}

	// A video saves in place as the container its name says (a rename to another leaves the editor saving copies only).
	if (category === "video") {
		return `video:${inPlaceVideoContainerByName(driveItemName(item)) ?? ""}`
	}

	// A deck saves as the package it opened as (a template stays a template, a show a show).
	if (category === "presentation") {
		const extension = extensionOf(driveItemName(item))

		return `presentation:${presentationSaveFormat(extension) ?? extension}`
	}

	if (category !== "spreadsheet") {
		return ""
	}

	const extension = extensionOf(driveItemName(item))

	return `spreadsheet:${spreadsheetSaveFormat(extension) ?? extension}`
}

// Opened as text, the slot stays the text viewer and never editable, whatever a rename later says.
function slotPin(item: DriveItem, variant: DriveVariant, asText: boolean): SlotPin {
	if (asText) {
		return { category: "text", format: "", editable: false }
	}

	return { category: previewType(item), format: saveFormat(item), editable: isEditable(item, variant) }
}

// What remounts the body. A spreadsheet, and a Word document opened for editing, follow their document (see
// documentKeys), so the user's own save keeps the editor; every other viewer follows the version shown, and a
// saved text file reopens on what was uploaded. By the pinned renderer, so a rename never remounts.
function bodyKey(item: DriveItem, documentKey: string, pin: SlotPin | null): string {
	if (pin?.category === "spreadsheet") {
		return `spreadsheet:${documentKey}`
	}

	// An editable deck follows its document too: its session moves onto each file it saves.
	if (pin?.category === "presentation" && pin.editable) {
		return `presentation:${documentKey}`
	}

	return pin?.category === "docx" && pin.editable ? `docx:${documentKey}` : item.data.uuid
}

interface PreviewBodyProps {
	item: DriveItem
	variant: DriveVariant
	// The drive slot's pinned renderer (SlotPin).
	category: PreviewCategory | undefined
	documentKey: string
	editable: boolean
	// Read-only because a rename changed the save format: the spreadsheet grid says so.
	renamedReadOnly: boolean
	// Outside the drive nothing is ever editable, so a spreadsheet keeps only what it shows.
	neverEditable: boolean
	// Opened through "Open as text" (the text viewer guards against a binary file).
	asText: boolean
	// A save in flight: text editors go read-only until it settles.
	locked: boolean
	onDirtyChange: (dirty: boolean) => void
	contentRef: RefObject<(() => string) | null>
	spreadsheetRef: RefObject<SpreadsheetSaveSource | null>
	docxRef: RefObject<DocxSaveSource | null>
	// The presentation editor's save source (its session streams each save to the upload).
	presentationRef: RefObject<PresentationSaveSource | null>
	// The image viewer's shown <img> (the image editor starts from its pixels).
	imageRef: RefObject<HTMLImageElement | null>
	// A save the user asked for in the viewer (a deck's File ▸ Save); true when one started.
	onSave: () => boolean
	// Idle autosave asks the overlay to save; true when a save started.
	onAutosave: () => boolean
	// Shows another file in this slot's place (the .xlsx an .xls was just saved as).
	onOpenFile: (item: DriveItem) => void
	// A converted copy may be written beside the file (its own drive, however read-only its format).
	canSaveCopy: boolean
}

// Dispatches to the right viewer by category — remounted (keyed by uuid, see the error boundary one
// level up) on every item change so a viewer's own pending/success/error state never flashes the
// previous item's content. Bytes are no longer loaded centrally here: image/video/audio each own their
// own data source (a streamed SW URL or a buffered blob, see imageViewer.tsx/mediaViewer.tsx),
// pdf/docx each own their own whole-buffer load (see pdfViewer.tsx/docxViewer.tsx)
// — a category still rendered by the fallback below (text/code/markdown) has nothing to load yet.
// `editable`/`onDirtyChange`/`contentRef` only ever reach a CodeMirror surface: the "text"/"code"
// case's TextViewer, and the "markdown" case's own source-mode editor — every other category
// ignores them.
//
// A missing category arm cannot ship as a silently blank overlay: the `default` arm at the bottom of
// the switch is the guard (a return-type annotation is not — `ReactNode` includes `undefined`).
function PreviewBody({
	item,
	variant,
	category: pinnedCategory,
	documentKey,
	editable,
	renamedReadOnly,
	neverEditable,
	asText,
	locked,
	onDirtyChange,
	contentRef,
	spreadsheetRef,
	docxRef,
	presentationRef,
	imageRef,
	onSave,
	onAutosave,
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
					imageRef={imageRef}
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
				<PdfViewer
					item={item}
					alt={alt}
				/>
			)
		case "spreadsheet":
			return (
				<SheetViewer
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
					onAutosave={onAutosave}
				/>
			)
		case "docx":
			return (
				<DocxViewer
					item={item}
					alt={alt}
					variant={variant}
					canSaveCopy={canSaveCopy}
					onOpenFile={onOpenFile}
					{...(neverEditable
						? {}
						: {
								editing: {
									writable: editable,
									renamed: renamedReadOnly,
									onDirtyChange,
									saveRef: docxRef,
									onAutosave
								}
							})}
				/>
			)
		// An editable deck is keyed by its document (bodyKey): its own saves move the session onto the saved file and
		// keep it mounted. The editor fills the overlay's presentationRef; one that cannot save shows the deck view-only.
		case "presentation":
			return (
				<PresentationViewer
					item={item}
					alt={alt}
					variant={variant}
					canSaveCopy={canSaveCopy}
					onOpenFile={onOpenFile}
					{...(neverEditable
						? {}
						: {
								editing: {
									writable: editable,
									renamed: renamedReadOnly,
									onDirtyChange,
									saveRef: presentationRef,
									onSave,
									onAutosave
								}
							})}
				/>
			)
		case "text":
		case "code":
			return (
				<TextViewer
					item={item}
					alt={alt}
					editable={editable}
					locked={locked}
					onDirtyChange={onDirtyChange}
					contentRef={contentRef}
					rejectBinary={asText}
				/>
			)
		case "markdown":
			return (
				<MarkdownViewer
					item={item}
					alt={alt}
					editable={editable}
					locked={locked}
					onDirtyChange={onDirtyChange}
					contentRef={contentRef}
				/>
			)
		case "rawImage":
			return (
				<RawImageViewer
					item={item}
					alt={alt}
				/>
			)
		case "archive":
			return (
				<ArchiveBrowser
					item={item}
					variant={variant}
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
