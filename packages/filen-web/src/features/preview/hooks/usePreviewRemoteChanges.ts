import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { toast } from "sonner"
import { conflictCopyName, decideRevision, driveItemName } from "@filen/shared"
import { asDirectoryOrFile, narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import {
	imageSaveTimes,
	runPreviewSave,
	type ImageSaveEdits,
	type PresentationSaveEdits,
	type PreviewSaveContent
} from "@/features/drive/lib/previewSave.logic"
import { currentRootUuid } from "@/features/drive/lib/actions"
import {
	cachedListing,
	driveListingQueryOptions,
	driveListingQueryUpdate,
	listingRowsVerified,
	normalizeParentUuid,
	type DriveListingParams
} from "@/features/drive/queries/drive"
import { emitPreviewFileMetaChanged, subscribePreviewReconcile, type PreviewReconcileEvent } from "@/features/preview/lib/previewReconcile"
import type { FileMeta } from "@filen/sdk-rs"
import { isRevisionOf, settleHeldRevisions, type PreviewRevision } from "@/features/preview/lib/remoteChange.logic"
import { usePreviewCacheScope } from "@/features/preview/lib/accessMode"
import { loadPreviewBytes } from "@/features/preview/lib/previewCache"
import { isOwnSave, recordOwnSave } from "@/features/preview/lib/ownSaves"
import { dropPreviewBuffer, usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"
import { queryClient } from "@/queries/client"
import { sdkApi } from "@/lib/sdk/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import type { ErrorDTO } from "@/lib/sdk/errors"
import { log } from "@/lib/log"
import { i18n } from "@/lib/i18n"

// What "save mine as new" writes: text or a document's bytes, a deck's streamed save, or an edited image.
export type PreviewEdits = Uint8Array | PresentationSaveEdits | ImageSaveEdits

// The overlay's own changes to the file on screen, whose echoes are not changes made elsewhere.
export type OwnChangeKind = "remove" | "move" | "restore"

// What the overlay asks while the file on screen holds unsaved edits: a newer version of it was saved
// elsewhere (`theirs`), or it was trashed or deleted. `afterSave`: asked once the overlay's own save
// settled, before a spreadsheet reported whether edits made during that save are still unsaved.
export type RemoteChangePrompt =
	{ kind: "revised"; frozenUuid: string; theirs: DriveItem; afterSave?: boolean } | { kind: "deleted"; frozenUuid: string }

interface UsePreviewRemoteChangesParams {
	variant: DriveVariant
	items: DriveItem[]
	index: number
	// The overlay's per-slot overrides (keyed by each slot's frozen uuid), read and written synchronously:
	// two revisions can arrive before the overlay renders again.
	savedRef: RefObject<ReadonlyMap<string, DriveItem>>
	commitSaved: (frozenUuid: string, item: DriveItem) => void
	contentRef: RefObject<(() => string) | null>
	// The unsaved edits as they stand: encoded, a deck's save its session streams to an upload, or an edited image.
	readEdits: () => Promise<PreviewEdits | null>
	onItemRemoved: (frozenUuid: string) => void
}

function isDirty(): boolean {
	return usePreviewUnsavedGuardStore.getState().dirty
}

interface OverlaySnapshot {
	variant: DriveVariant
	items: DriveItem[]
	index: number
	commitSaved: (frozenUuid: string, item: DriveItem) => void
	onItemRemoved: (frozenUuid: string) => void
}

// Where each slot's displayed file sits in the pager, by its displayed uuid and by its lineage id, so an
// event finds its slot without walking a pager that can hold a whole photo library. Rebuilt only when
// the slots or their overrides change (both are replaced, never mutated).
interface SlotIndex {
	items: DriveItem[]
	saved: ReadonlyMap<string, DriveItem>
	byUuid: Map<string, number>
	byStable: Map<string, number>
}

// A trash, delete or move that reached the file on screen while the overlay's own save was in flight.
// `hostKnows`: the pager heard of it too (a socket event), and drops a slot it knows by that uuid itself.
interface HeldLeaving {
	uuid: string
	moved: DriveItem | null
	hostKnows: boolean
}

// Everything the socket-driven handlers below reach, all of it stable across renders: they run from a
// subscription made once, reading the overlay's current state through `latest`.
interface RemoteChangeContext {
	latest: RefObject<OverlaySnapshot>
	savedRef: RefObject<ReadonlyMap<string, DriveItem>>
	slots: RefObject<SlotIndex | null>
	// Per slot, the revision the user chose to keep their edits over, so it is not asked about twice.
	keptOver: RefObject<Map<string, string>>
	saving: RefObject<boolean>
	held: RefObject<PreviewRevision[]>
	heldLeaving: RefObject<HeldLeaving[]>
	// Slots (frozen uuid → the gone file's uuid) kept on screen for their unsaved edits: the pager, which
	// skipped removing them while dirty, drops them once the user leaves them.
	keptGone: RefObject<Map<string, string>>
	// Displayed uuids this overlay is trashing or deleting, moving, or restoring a version of: their echoes
	// are the user's own doing, never a change made elsewhere.
	ownChanges: RefObject<Map<string, OwnChangeKind>>
	// Socket reconnects seen, and per slot (frozen uuid) the count it was last checked against.
	reconnects: RefObject<number>
	checkedAt: RefObject<Map<string, number>>
	// The prompt as last set, for code that awaits: a newer revision can replace it meanwhile.
	promptRef: RefObject<RemoteChangePrompt | null>
	setPrompt: Dispatch<SetStateAction<RemoteChangePrompt | null>>
}

function displayedOf(ctx: RemoteChangeContext, item: DriveItem | undefined): { frozenUuid: string; displayed: DriveItem } | null {
	if (item === undefined) {
		return null
	}

	const frozenUuid = item.data.uuid

	return { frozenUuid, displayed: ctx.savedRef.current.get(frozenUuid) ?? item }
}

function displayedUuid(ctx: RemoteChangeContext, frozenUuid: string): string {
	return ctx.savedRef.current.get(frozenUuid)?.data.uuid ?? frozenUuid
}

function slotIndex(ctx: RemoteChangeContext): SlotIndex {
	const items = ctx.latest.current.items
	const saved = ctx.savedRef.current
	const cached = ctx.slots.current

	if (cached?.items === items && cached.saved === saved) {
		return cached
	}

	const byUuid = new Map<string, number>()
	const byStable = new Map<string, number>()

	items.forEach((item, sourceIndex) => {
		const displayed = saved.get(item.data.uuid) ?? item

		byUuid.set(displayed.data.uuid, sourceIndex)

		if (displayed.type === "file" && displayed.data.stableUUID !== undefined) {
			byStable.set(displayed.data.stableUUID, sourceIndex)
		}
	})

	const next = { items, saved, byUuid, byStable }

	ctx.slots.current = next

	return next
}

function takeOwnChange(ctx: RemoteChangeContext, uuid: string, kind: OwnChangeKind): boolean {
	if (ctx.ownChanges.current.get(uuid) !== kind) {
		return false
	}

	ctx.ownChanges.current.delete(uuid)

	return true
}

// The slot `revision` is a newer version of: by lineage id, or by the uuid a version restore replaced.
function revisedSlot(ctx: RemoteChangeContext, revision: PreviewRevision): number | undefined {
	const slots = slotIndex(ctx)
	const stableUuid = revision.item.type === "file" ? revision.item.data.stableUUID : undefined
	const candidates = [
		stableUuid === undefined ? undefined : slots.byStable.get(stableUuid),
		revision.previousUuid === undefined ? undefined : slots.byUuid.get(revision.previousUuid)
	]

	return candidates.find(sourceIndex => {
		const slot = sourceIndex === undefined ? null : displayedOf(ctx, slots.items[sourceIndex])

		return slot !== null && isRevisionOf(slot.displayed, revision)
	})
}

// `sourceIndex`: the slot, when the caller already matched it.
function handleRevision(
	ctx: RemoteChangeContext,
	revision: PreviewRevision,
	afterSave: boolean,
	sourceIndex = revisedSlot(ctx, revision)
): void {
	const latest = ctx.latest.current
	const slot = sourceIndex === undefined ? null : displayedOf(ctx, latest.items[sourceIndex])

	if (slot === null) {
		return
	}

	// A version the user restored here is shown unannounced; over unsaved edits it still asks, as
	// taking it would drop them.
	const ownRestore = revision.previousUuid !== undefined && takeOwnChange(ctx, revision.previousUuid, "restore")
	const decision = decideRevision({
		current: sourceIndex === latest.index,
		dirty: isDirty(),
		saving: ctx.saving.current,
		keptOver: ctx.keptOver.current.get(slot.frozenUuid),
		revisionUuid: revision.item.data.uuid
	})

	switch (decision.type) {
		case "ignore":
			return
		case "hold":
			ctx.held.current.push(revision)

			return
		case "ask":
			ctx.setPrompt({ kind: "revised", frozenUuid: slot.frozenUuid, theirs: revision.item, ...(afterSave ? { afterSave } : {}) })

			return
		case "show":
			latest.commitSaved(slot.frozenUuid, revision.item)

			// A version this tab saved before a reload, met again through a listing restored from disk, is the user's own.
			if (decision.announce && !ownRestore && !isOwnSave(revision.item.data.uuid)) {
				toast(i18n.t("preview:previewUpdatedElsewhere"))
			}

			return
	}
}

// A trash, delete or move of a file the preview shows. The pager drops such a slot itself, except the one
// holding unsaved edits (previewProtectedUuid), and a slot whose uuid a save here rotated, which it knows
// by its frozen uuid only; `hostKnows` false (found gone after a reconnect) means it dropped nothing.
function handleLeaving(ctx: RemoteChangeContext, uuid: string, moved: DriveItem | null, hostKnows: boolean): void {
	const latest = ctx.latest.current
	const sourceIndex = slotIndex(ctx).byUuid.get(uuid)
	const slot = sourceIndex === undefined ? null : displayedOf(ctx, latest.items[sourceIndex])

	if (slot === null) {
		return
	}

	const edited = sourceIndex === latest.index && isDirty()

	// Judged once the save settles: a save that lands made a new file there, and one that failed still
	// holds the edits this asks about. Asking now would let a Discard drop the slot under the upload.
	if (edited && ctx.saving.current) {
		ctx.heldLeaving.current.push({ uuid, moved, hostKnows })

		return
	}

	const own = takeOwnChange(ctx, uuid, moved === null ? "remove" : "move")

	if (edited) {
		if (moved === null) {
			// The user's own trash or delete removes the slot once it returns (onItemRemoved).
			if (!own) {
				ctx.setPrompt({ kind: "deleted", frozenUuid: slot.frozenUuid })
			}
		} else {
			// Same uuid, so the editor stays mounted; a save now lands in the new directory.
			latest.commitSaved(slot.frozenUuid, moved)

			if (!own) {
				toast(i18n.t("preview:previewMovedElsewhere"))
			}
		}

		return
	}

	if (!hostKnows || slot.frozenUuid !== uuid) {
		latest.onItemRemoved(slot.frozenUuid)
	}
}

// A rename reaches the pager's frozen items (reconcilePreviewSources), but a slot a save or a newer
// version re-pointed shows its override, which is patched here, or a later save would upload under the
// old name as a new file. The owned-file arm only, like the pager's own patch.
function handleFileMeta(ctx: RemoteChangeContext, uuid: string, meta: FileMeta): void {
	for (const [frozenUuid, item] of ctx.savedRef.current) {
		if (item.type === "file" && item.data.uuid === uuid) {
			ctx.latest.current.commitSaved(frozenUuid, narrowItem({ ...item.data, meta }))
		}
	}
}

// Where a slot's file is looked up, if anywhere. In My Drive: its directory's listing, after each reconnect
// and while that listing is unverified. Elsewhere: only while unverified, the cached listing of the variant
// that holds it (a flat listing's own, a shared directory's, or the shared root's for a file shared on its
// own), as a preview of that variant may also open from elsewhere (a chat's link). `uuids`: the slot's
// frozen and displayed uuids, either of which that listing may hold.
function lookupListing(
	variant: DriveVariant,
	displayed: DriveItem,
	uuids: readonly string[],
	checked: number | undefined,
	reconnects: number
): DriveListingParams | null {
	if (variant === "drive") {
		const params: DriveListingParams = { variant, uuid: normalizeParentUuid(displayed.data.parent, currentRootUuid()) }
		const unread = !listingRowsVerified(params.variant, params.uuid)

		return (checked ?? (unread ? -1 : 0)) < reconnects ? params : null
	}

	if (checked !== undefined) {
		return null
	}

	const candidates = variant === "sharedIn" || variant === "sharedOut" ? [displayed.data.parent, null] : [null]

	for (const uuid of candidates) {
		if (!listingRowsVerified(variant, uuid) && cachedListing(variant, uuid)?.some(row => uuids.includes(row.data.uuid)) === true) {
			return { variant, uuid }
		}
	}

	return null
}

// The file on screen is looked up in the listing it came from when that listing's rows are not yet
// verified (restored from disk at boot, not read since): its row may name a version since replaced, which
// the preview would show, and an edit overwrite. In My Drive it is also looked up after a socket drop, once
// per reconnect: a newer version, a rename, or its absence (trashed or moved away meanwhile) is answered as
// the missed event would have been. A slot off screen is looked up when it comes on screen. The lookup joins
// the read under way (the listing's mount read, a reconnect's re-read) or reuses its result. Elsewhere a
// row's absence proves nothing (a recent ages out, a shared file's new version is another file), and a
// listing that rereads on every mount and focus needs no lookup once read.
async function checkCurrentSlot(ctx: RemoteChangeContext): Promise<void> {
	const latest = ctx.latest.current
	const slot = displayedOf(ctx, latest.items[latest.index])
	const reconnects = ctx.reconnects.current

	if (slot === null) {
		return
	}

	const myDrive = latest.variant === "drive"
	const checked = ctx.checkedAt.current.get(slot.frozenUuid)
	const source = lookupListing(latest.variant, slot.displayed, [slot.frozenUuid, slot.displayed.data.uuid], checked, reconnects)

	// Outside My Drive nothing reopens a slot's lookup, so one found needless is not weighed again.
	if (source !== null || !myDrive) {
		ctx.checkedAt.current.set(slot.frozenUuid, reconnects)
	}

	const displayed = slot.displayed

	if (source === null || asDirectoryOrFile(displayed).type !== "file") {
		return
	}

	const uuid = displayed.data.uuid
	const stableUuid = displayed.type === "file" || displayed.type === "sharedFile" ? displayed.data.stableUUID : undefined
	let listing: DriveItem[]

	try {
		listing = await queryClient.query(driveListingQueryOptions(source.variant, source.uuid))
	} catch (e) {
		log.warn("preview", "looking the file on screen up in its listing failed", e)

		return
	}

	// An event may have moved the slot on meanwhile; that one is newer than this listing.
	if (displayedUuid(ctx, slot.frozenUuid) !== uuid) {
		return
	}

	const found = listing.find(
		item =>
			item.data.uuid === uuid ||
			(stableUuid !== undefined && (item.type === "file" || item.type === "sharedFile") && item.data.stableUUID === stableUuid)
	)

	if (found === undefined) {
		if (myDrive) {
			handleLeaving(ctx, uuid, null, false)
		}

		return
	}

	const foundFile = asDirectoryOrFile(found)

	if (found.data.uuid !== uuid) {
		handleRevision(ctx, { item: found }, false, slotIndex(ctx).byUuid.get(uuid))
	} else if (foundFile.type === "file" && driveItemName(found) !== driveItemName(displayed)) {
		// Reaches the pager and this overlay's overrides alike.
		emitPreviewFileMetaChanged(uuid, foundFile.data.meta)
	}
}

function handleEvent(ctx: RemoteChangeContext, event: PreviewReconcileEvent): void {
	switch (event.type) {
		case "revised":
			handleRevision(ctx, event.revision, false)

			break
		case "removed":
			handleLeaving(ctx, event.uuid, null, true)

			break
		case "moved":
			handleLeaving(ctx, event.item.data.uuid, event.item, true)

			break
		case "restored":
			// The file whose deletion is being asked about, or held until a save settles, is back.
			ctx.heldLeaving.current = ctx.heldLeaving.current.filter(held => held.moved !== null || held.uuid !== event.uuid)

			for (const [frozenUuid, goneUuid] of ctx.keptGone.current) {
				if (goneUuid === event.uuid) {
					ctx.keptGone.current.delete(frozenUuid)
				}
			}

			ctx.setPrompt(prev => (prev?.kind === "deleted" && displayedUuid(ctx, prev.frozenUuid) === event.uuid ? null : prev))

			break
		case "resync":
			ctx.reconnects.current++
			void checkCurrentSlot(ctx)

			break
		case "fileMeta":
			handleFileMeta(ctx, event.uuid, event.meta)

			break
		case "folderMeta":
			break
	}
}

// The upload behind the hook's saveMineAsNewFile; null when there was nothing to write or the upload
// failed (either already told). Module scope: the React Compiler cannot lower an await inside a
// conditional expression, and would skip the whole hook. `bytes`: a copy of what was uploaded (the upload
// hands its buffer to the SDK worker), kept only where the preview goes on to show the new file. A deck's
// edits are a save its session streams to the upload (never bytes here): its copy opens anew from the drive.
async function writeAsNewFile(
	asked: RemoteChangePrompt,
	item: DriveItem,
	readEdits: () => Promise<PreviewEdits | null>,
	t: TFunction<"preview">
): Promise<{ item: DriveItem; name: string; bytes: Uint8Array | null } | null> {
	const content = await readEdits()
	const base = asDirectoryOrFile(item)

	// Not offered without a save source; never silent if it gets here anyway.
	if (content === null || base.type !== "file") {
		if (content !== null && "kind" in content && content.kind === "port") {
			content.port.close()
		}

		toast.error(t("previewSaveAsNewFileFailed"))

		return null
	}

	const bytes = asked.kind === "deleted" && !("kind" in content) ? content.slice() : null
	// An image written in another format than the original's is named for it, and typed by that name.
	const extension = "kind" in content && content.kind === "blob" ? content.extension : null

	const rootUuid = currentRootUuid()
	const parent = normalizeParentUuid(base.data.parent, rootUuid)
	const original = extension === null ? driveItemName(base) : withExtension(driveItemName(base), extension)
	const taken = (name: string) => sdkApi.nameExistsInDirectory(parent, name)
	const name =
		asked.kind === "deleted" && !(await taken(original))
			? original
			: await conflictCopyName(original, new Date(), args => t("previewConflictCopyName", args), taken)
	const outcome = !("kind" in content)
		? await uploadCopy(item, content, name, rootUuid)
		: content.kind === "port"
			? await uploadDeckCopy(item, content, name, rootUuid)
			: await uploadCopy(item, { blob: content.blob }, name, rootUuid, {
					times: imageSaveTimes(item, Date.now()),
					...(extension === null ? {} : { mime: "" })
				})

	if (outcome.status === "error") {
		if (outcome.dto !== null) {
			toast.error(errorLabel(outcome.dto))
		} else {
			toast.error(t("previewSaveAsNewFileFailed"))
		}

		return null
	}

	return { item: outcome.item, name, bytes }
}

// "photo.heic" → "photo.jpg".
function withExtension(name: string, extension: string): string {
	const dot = name.lastIndexOf(".")

	return `${dot > 0 ? name.slice(0, dot) : name}.${extension}`
}

type CopyOutcome = { status: "success"; item: DriveItem } | { status: "error"; dto: ErrorDTO | null }

// `extra`: an edited image's times, and "" as its mime when its format is not the original's.
async function uploadCopy(
	item: DriveItem,
	content: PreviewSaveContent,
	name: string,
	rootUuid: string,
	extra?: { times?: { created: bigint; modified: bigint }; mime?: string }
): Promise<CopyOutcome> {
	return await runPreviewSave(
		{
			uploadFileBytes: (parentUuid, data, fileName, mime, options) =>
				sdkApi.uploadFileBytes(parentUuid, data, fileName, mime, options),
			uploadFileFromPort: (parentUuid, port, fileName, mime, options) =>
				sdkApi.uploadFileFromPort(parentUuid, fileName, mime, port, options),
			uploadFileBlob: (parentUuid, blob, fileName, mime, options) =>
				sdkApi.uploadFileFromBlob(parentUuid, blob, fileName, mime, options),
			patchListing: driveListingQueryUpdate,
			rootUuid
		},
		{ item, content, asNewFile: name, ...extra }
	)
}

// A deck's copy: the session writes its whole package (the edits on the file as it opened) to the upload, opened
// only once the session says it writes. The session is not moved onto the copy: the preview reopens on whichever
// file it shows next, and the session closes with the editor that held it.
async function uploadDeckCopy(item: DriveItem, edits: PresentationSaveEdits, name: string, rootUuid: string): Promise<CopyOutcome> {
	const writes = await Promise.race([
		edits.announced,
		edits.result.then(
			() => false,
			() => false
		)
	])

	if (!writes) {
		edits.port.close()
		await edits.result.catch(() => undefined)

		return { status: "error", dto: null }
	}

	const [outcome, result] = await Promise.all([
		uploadCopy(item, { port: edits.port }, name, rootUuid),
		edits.result.catch((e: unknown) => {
			log.error("preview", "the presentation copy failed", e)

			return { kind: "refused" as const }
		})
	])

	if (outcome.status === "error") {
		return outcome
	}

	return result.kind === "written" ? outcome : { status: "error", dto: null }
}

// Keeps an open preview on the latest version of its files, and asks before that would lose unsaved
// edits (the rules are @filen/shared's remoteChange.ts). The overlay reports its own saves (saveStarted /
// saveSettled), so a save from this editor never reads as someone else's.
export function usePreviewRemoteChanges({
	variant,
	items,
	index,
	savedRef,
	commitSaved,
	contentRef,
	readEdits,
	onItemRemoved
}: UsePreviewRemoteChangesParams) {
	const { t } = useTranslation("preview")
	const cacheScope = usePreviewCacheScope()
	const [prompt, setPromptState] = useState<RemoteChangePrompt | null>(null)
	const promptRef = useRef<RemoteChangePrompt | null>(null)
	const [pending, setPending] = useState(false)
	// The same, for a second click landing before the render that disables the button.
	const pendingRef = useRef(false)
	const keptOver = useRef(new Map<string, string>())
	const saving = useRef(false)
	const held = useRef<PreviewRevision[]>([])
	const heldLeaving = useRef<HeldLeaving[]>([])
	const keptGone = useRef(new Map<string, string>())
	const ownChanges = useRef(new Map<string, OwnChangeKind>())
	const slots = useRef<SlotIndex | null>(null)
	const reconnects = useRef(0)
	const checkedAt = useRef(new Map<string, number>())
	const latest = useRef<OverlaySnapshot>({ variant, items, index, commitSaved, onItemRemoved })
	const [ctx] = useState<RemoteChangeContext>(() => ({
		latest,
		savedRef,
		slots,
		keptOver,
		saving,
		held,
		heldLeaving,
		keptGone,
		ownChanges,
		reconnects,
		checkedAt,
		promptRef,
		setPrompt: action => {
			const next = typeof action === "function" ? action(promptRef.current) : action

			promptRef.current = next
			setPromptState(next)
		}
	}))
	const setPrompt = ctx.setPrompt

	useEffect(() => {
		latest.current = { variant, items, index, commitSaved, onItemRemoved }
	})

	// A prompt belongs to the slot it asks about. One left behind when that slot went (the user's own
	// trash racing its echo, say) is dropped, never shown over the next file, whose buffer it cannot save.
	const currentFrozenUuid = items[index]?.data.uuid ?? null

	if (prompt !== null && prompt.frozenUuid !== currentFrozenUuid) {
		setPrompt(null)
	}

	useEffect(() => {
		const unsubscribe = subscribePreviewReconcile(event => {
			handleEvent(ctx, event)
		})
		// A question asked right after a save of a spreadsheet, whose edits during that save then turned
		// out saved too: nothing of the user's is at stake, so the newer version is shown instead.
		const unsubscribeDirty = usePreviewUnsavedGuardStore.subscribe((state, prev) => {
			const asked = ctx.promptRef.current

			if (!prev.dirty || state.dirty || asked?.kind !== "revised" || asked.afterSave !== true) {
				return
			}

			ctx.setPrompt(null)
			ctx.latest.current.commitSaved(asked.frozenUuid, asked.theirs)
			toast(i18n.t("preview:previewUpdatedElsewhere"))
		})

		return () => {
			unsubscribe()
			unsubscribeDirty()
		}
	}, [ctx])

	// A slot that comes on screen after a reconnect it missed is looked up then. Declared after the
	// effect that updates `latest`, so it reads this render's slot.
	useEffect(() => {
		if (currentFrozenUuid !== null) {
			void checkCurrentSlot(ctx)
		}
	}, [ctx, currentFrozenUuid])

	// A gone file kept on screen leaves the pager once the user steps away from it (with unsaved edits,
	// only through the discard prompt), after the render that steps, so the pager keeps the slot the user
	// went to. Never while it stays on screen: an undo back to the saved text reads as clean too, and must
	// not drop the slot and its redo history. A slot that shows another file by then (saved as a new one)
	// stays.
	useEffect(() => {
		for (const [frozenUuid, goneUuid] of keptGone.current) {
			if (frozenUuid === currentFrozenUuid) {
				continue
			}

			keptGone.current.delete(frozenUuid)

			if (displayedUuid(ctx, frozenUuid) === goneUuid) {
				latest.current.onItemRemoved(frozenUuid)
			}
		}
	}, [ctx, currentFrozenUuid])

	function saveStarted(): void {
		saving.current = true
	}

	// `savedItem` is what the save made, null when it failed. Call it after the overlay has shown
	// `savedItem` (and cleared its dirty bit, where the save left nothing unsaved), so what arrived during
	// the save is judged against both.
	function saveSettled(savedItem: DriveItem | null): void {
		saving.current = false

		if (savedItem !== null) {
			recordOwnSave(savedItem.data.uuid)
		}

		const settled = settleHeldRevisions(held.current, savedItem?.data.uuid ?? null)
		const leaving = heldLeaving.current

		held.current = []
		heldLeaving.current = []

		if (settled.replaced) {
			toast(t("previewSaveReplacedNewer"))
		}

		for (const revision of settled.newer) {
			handleRevision(ctx, revision, savedItem !== null)
		}

		// Against the saved version these no longer match a slot: the file they name is not what it shows.
		for (const event of leaving) {
			handleLeaving(ctx, event.uuid, event.moved, event.hostKnows)
		}
	}

	function slotItem(frozenUuid: string): DriveItem | undefined {
		const item = items.find(candidate => candidate.data.uuid === frozenUuid)

		return item === undefined ? undefined : (savedRef.current.get(frozenUuid) ?? item)
	}

	function keepMine(): void {
		if (prompt?.kind === "revised") {
			keptOver.current.set(prompt.frozenUuid, prompt.theirs.data.uuid)
		} else if (prompt?.kind === "deleted") {
			keptGone.current.set(prompt.frozenUuid, displayedUuid(ctx, prompt.frozenUuid))
		}

		setPrompt(null)
	}

	function loadTheirs(): void {
		if (prompt?.kind !== "revised") {
			return
		}

		setPrompt(null)
		dropPreviewBuffer(contentRef)
		commitSaved(prompt.frozenUuid, prompt.theirs)
	}

	function discardMine(): void {
		if (prompt?.kind !== "deleted") {
			return
		}

		setPrompt(null)
		dropPreviewBuffer(contentRef)
		onItemRemoved(prompt.frozenUuid)
	}

	// Writes the unsaved edits beside the file as a new one: a conflicted copy when the file moved on to
	// another version (which the preview then shows), or the file's own name again when it was deleted and
	// that name is free (the preview then shows the new file).
	async function saveMineAsNewFile(): Promise<void> {
		const asked = prompt
		const item = asked === null ? undefined : slotItem(asked.frozenUuid)

		if (asked === null || item === undefined || pendingRef.current) {
			return
		}

		// Before anything is awaited: reading a spreadsheet's edits takes a while.
		pendingRef.current = true
		setPending(true)

		const outcome = await writeAsNewFile(asked, item, readEdits, t).catch((e: unknown) => {
			log.error("preview", "saving unsaved edits as a new file failed", e)
			toast.error(t("previewSaveAsNewFileFailed"))

			return null
		})

		pendingRef.current = false
		setPending(false)

		if (outcome === null) {
			return
		}

		// The newest question about the slot, as a revision may have arrived during the upload.
		const newest = promptRef.current?.frozenUuid === asked.frozenUuid ? promptRef.current : asked

		setPrompt(null)
		dropPreviewBuffer(contentRef)

		if (newest.kind === "revised") {
			commitSaved(asked.frozenUuid, newest.theirs)
		} else {
			// The preview reopens on the new file without downloading what it just uploaded.
			if (outcome.bytes !== null) {
				const bytes = outcome.bytes

				void loadPreviewBytes(cacheScope, outcome.item.data.uuid, bytes.byteLength, () => Promise.resolve(bytes))
			}

			commitSaved(asked.frozenUuid, outcome.item)
		}

		toast.success(t("previewSavedAsNewFile", { name: outcome.name }))
	}

	// Around the overlay's own trash, delete, move or version restore of the file on screen (its displayed
	// uuid). The mark is taken by that change's echo, or dropped by the caller when nothing changed.
	function expectOwnChange(uuid: string, kind: OwnChangeKind): void {
		ownChanges.current.set(uuid, kind)
	}

	function forgetOwnChange(uuid: string): void {
		ownChanges.current.delete(uuid)
	}

	return {
		prompt,
		pending,
		saveStarted,
		saveSettled,
		keepMine,
		loadTheirs,
		discardMine,
		saveMineAsNewFile,
		expectOwnChange,
		forgetOwnChange
	}
}
