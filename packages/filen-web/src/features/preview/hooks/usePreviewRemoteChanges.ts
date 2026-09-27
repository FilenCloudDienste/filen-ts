import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { conflictCopyName, decideRevision, driveItemName } from "@filen/shared"
import { asDirectoryOrFile, narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { runPreviewSave } from "@/features/drive/lib/previewSave.logic"
import { currentRootUuid } from "@/features/drive/lib/actions"
import { driveListingQueryOptions, driveListingQueryUpdate, normalizeParentUuid } from "@/features/drive/queries/drive"
import { subscribePreviewReconcile, type PreviewReconcileEvent } from "@/features/preview/lib/previewReconcile"
import type { FileMeta } from "@filen/sdk-rs"
import { isRevisionOf, settleHeldRevisions, type PreviewRevision } from "@/features/preview/lib/remoteChange.logic"
import { type PreviewSource } from "@/features/preview/lib/previewSource"
import { setPreviewDirty, usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"
import { queryClient } from "@/queries/client"
import { sdkApi } from "@/lib/sdk/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { log } from "@/lib/log"
import { i18n } from "@/lib/i18n"

// What the overlay asks while the file on screen holds unsaved edits: a newer version of it was saved
// elsewhere (`theirs`), or it was trashed or deleted.
// The overlay's own changes to the file on screen, whose echoes are not changes made elsewhere.
export type OwnChangeKind = "remove" | "move" | "restore"

export type RemoteChangePrompt = { kind: "revised"; frozenUuid: string; theirs: DriveItem } | { kind: "deleted"; frozenUuid: string }

interface UsePreviewRemoteChangesParams {
	variant: DriveVariant
	items: PreviewSource[]
	index: number
	// The overlay's per-slot overrides (keyed by each slot's frozen uuid), read and written synchronously:
	// two revisions can arrive before the overlay renders again.
	savedRef: RefObject<ReadonlyMap<string, DriveItem>>
	commitSaved: (frozenUuid: string, item: DriveItem) => void
	contentRef: RefObject<string | null>
	// The unsaved edits as they stand: a text buffer, or a spreadsheet's file as edited.
	readEdits: () => Promise<string | Uint8Array | null>
	onItemRemoved: (frozenUuid: string) => void
}

function isDirty(): boolean {
	return usePreviewUnsavedGuardStore.getState().dirty
}

interface OverlaySnapshot {
	variant: DriveVariant
	items: PreviewSource[]
	index: number
	commitSaved: (frozenUuid: string, item: DriveItem) => void
	onItemRemoved: (frozenUuid: string) => void
}

// Everything the socket-driven handlers below reach, all of it stable across renders: they run from a
// subscription made once, reading the overlay's current state through `latest`.
interface RemoteChangeContext {
	latest: RefObject<OverlaySnapshot>
	savedRef: RefObject<ReadonlyMap<string, DriveItem>>
	// Per slot, the revision the user chose to keep their edits over, so it is not asked about twice.
	keptOver: RefObject<Map<string, string>>
	saving: RefObject<boolean>
	held: RefObject<PreviewRevision[]>
	// Displayed uuids this overlay is trashing or deleting, moving, or restoring a version of: their echoes
	// are the user's own doing, never a change made elsewhere.
	ownChanges: RefObject<Map<string, OwnChangeKind>>
	setPrompt: Dispatch<SetStateAction<RemoteChangePrompt | null>>
}

function displayedOf(ctx: RemoteChangeContext, source: PreviewSource): { frozenUuid: string; displayed: DriveItem } | null {
	if (source.type !== "drive") {
		return null
	}

	const frozenUuid = source.item.data.uuid

	return { frozenUuid, displayed: ctx.savedRef.current.get(frozenUuid) ?? source.item }
}

function displayedUuid(ctx: RemoteChangeContext, frozenUuid: string): string {
	return ctx.savedRef.current.get(frozenUuid)?.data.uuid ?? frozenUuid
}

function takeOwnChange(ctx: RemoteChangeContext, uuid: string, kind: OwnChangeKind): boolean {
	if (ctx.ownChanges.current.get(uuid) !== kind) {
		return false
	}

	ctx.ownChanges.current.delete(uuid)

	return true
}

function handleRevision(ctx: RemoteChangeContext, revision: PreviewRevision): void {
	const latest = ctx.latest.current

	latest.items.forEach((source, sourceIndex) => {
		const slot = displayedOf(ctx, source)

		if (slot === null || !isRevisionOf(slot.displayed, revision)) {
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
				ctx.setPrompt({ kind: "revised", frozenUuid: slot.frozenUuid, theirs: revision.item })

				return
			case "show":
				latest.commitSaved(slot.frozenUuid, revision.item)

				if (decision.announce && !ownRestore) {
					toast(i18n.t("preview:previewUpdatedElsewhere"))
				}

				return
		}
	})
}

// A trash, delete or move of a file the preview shows. The pager drops such a slot itself, except the one
// holding unsaved edits (previewProtectedUuid), and a slot whose uuid a save here rotated, which it knows
// by its frozen uuid only.
function handleLeaving(ctx: RemoteChangeContext, uuid: string, moved: DriveItem | null): void {
	const latest = ctx.latest.current

	latest.items.forEach((source, sourceIndex) => {
		const slot = displayedOf(ctx, source)

		if (slot?.displayed.data.uuid !== uuid) {
			return
		}

		const own = takeOwnChange(ctx, uuid, moved === null ? "remove" : "move")

		if (sourceIndex === latest.index && isDirty()) {
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

		if (slot.frozenUuid !== uuid) {
			latest.onItemRemoved(slot.frozenUuid)
		}
	})
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

// After a socket drop, the file on screen is looked up once in its directory's listing, which the
// reconnect re-reads anyway (the fetch joins that read), in case a newer version landed meanwhile.
async function resync(ctx: RemoteChangeContext): Promise<void> {
	const latest = ctx.latest.current
	const source = latest.items[latest.index]
	const slot = source === undefined ? null : displayedOf(ctx, source)

	if (latest.variant !== "drive" || slot?.displayed.type !== "file" || slot.displayed.data.stableUUID === undefined) {
		return
	}

	const stableUuid = slot.displayed.data.stableUUID

	try {
		const listing = await queryClient.query(
			driveListingQueryOptions("drive", normalizeParentUuid(slot.displayed.data.parent, currentRootUuid()))
		)
		const latestVersion = listing.find(item => item.type === "file" && item.data.stableUUID === stableUuid)

		if (latestVersion !== undefined) {
			handleRevision(ctx, { item: latestVersion })
		}
	} catch (e) {
		log.warn("preview", "resync after reconnect failed", e)
	}
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
	const [prompt, setPromptState] = useState<RemoteChangePrompt | null>(null)
	// The prompt as last set, for code that awaits: a newer revision can replace it meanwhile.
	const promptRef = useRef<RemoteChangePrompt | null>(null)
	const [pending, setPending] = useState(false)
	const keptOver = useRef(new Map<string, string>())
	const saving = useRef(false)
	const held = useRef<PreviewRevision[]>([])
	const ownChanges = useRef(new Map<string, OwnChangeKind>())
	const latest = useRef<OverlaySnapshot>({ variant, items, index, commitSaved, onItemRemoved })

	useEffect(() => {
		latest.current = { variant, items, index, commitSaved, onItemRemoved }
	})

	const setPrompt: Dispatch<SetStateAction<RemoteChangePrompt | null>> = action => {
		const next = typeof action === "function" ? action(promptRef.current) : action

		promptRef.current = next
		setPromptState(next)
	}

	// A prompt belongs to the slot it asks about. One left behind when that slot went (the user's own
	// trash racing its echo, say) is dropped, never shown over the next file, whose buffer it cannot save.
	const currentSource = items[index]
	const currentFrozenUuid = currentSource?.type === "drive" ? currentSource.item.data.uuid : null

	if (prompt !== null && prompt.frozenUuid !== currentFrozenUuid) {
		setPrompt(null)
	}

	useEffect(() => {
		const ctx: RemoteChangeContext = { latest, savedRef, keptOver, saving, held, ownChanges, setPrompt }

		return subscribePreviewReconcile((event: PreviewReconcileEvent) => {
			switch (event.type) {
				case "revised":
					handleRevision(ctx, event.revision)

					break
				case "removed":
					handleLeaving(ctx, event.uuid, null)

					break
				case "moved":
					handleLeaving(ctx, event.item.data.uuid, event.item)

					break
				case "restored":
					// The file whose deletion is being asked about is back: nothing to ask anymore.
					setPrompt(prev => (prev?.kind === "deleted" && displayedUuid(ctx, prev.frozenUuid) === event.uuid ? null : prev))

					break
				case "resync":
					void resync(ctx)

					break
				case "fileMeta":
					handleFileMeta(ctx, event.uuid, event.meta)

					break
				case "folderMeta":
					break
			}
		})
	}, [savedRef])

	function saveStarted(): void {
		saving.current = true
	}

	// `savedItem` is what the save made, null when it failed. Call it after the overlay has shown
	// `savedItem` and cleared its dirty bit, so revisions newer than the save are judged against both.
	function saveSettled(savedItem: DriveItem | null): void {
		saving.current = false

		const settled = settleHeldRevisions(held.current, savedItem?.data.uuid ?? null)

		held.current = []

		if (settled.replaced) {
			toast(t("previewSaveReplacedNewer"))
		}

		for (const revision of settled.newer) {
			handleRevision({ latest, savedRef, keptOver, saving, held, ownChanges, setPrompt }, revision)
		}
	}

	function slotItem(frozenUuid: string): DriveItem | undefined {
		const source = items.find(candidate => candidate.type === "drive" && candidate.item.data.uuid === frozenUuid)

		return source?.type === "drive" ? (savedRef.current.get(frozenUuid) ?? source.item) : undefined
	}

	function dropBuffer(): void {
		setPreviewDirty(false)
		contentRef.current = null
	}

	function keepMine(): void {
		if (prompt?.kind === "revised") {
			keptOver.current.set(prompt.frozenUuid, prompt.theirs.data.uuid)
		}

		setPrompt(null)
	}

	function loadTheirs(): void {
		if (prompt?.kind !== "revised") {
			return
		}

		dropBuffer()
		commitSaved(prompt.frozenUuid, prompt.theirs)
		setPrompt(null)
	}

	function discardMine(): void {
		if (prompt?.kind !== "deleted") {
			return
		}

		dropBuffer()
		setPrompt(null)
		onItemRemoved(prompt.frozenUuid)
	}

	// Writes the unsaved edits beside the file as a new one: a conflicted copy when the file moved on to
	// another version (which the preview then shows), or the file's own name again when it was deleted and
	// that name is free (the preview then shows the new file).
	async function saveMineAsNewFile(): Promise<void> {
		const item = prompt === null ? undefined : slotItem(prompt.frozenUuid)
		const content = await readEdits().catch(() => null)

		if (prompt === null || item === undefined || content === null) {
			return
		}

		const base = asDirectoryOrFile(item)

		if (base.type !== "file") {
			return
		}

		const rootUuid = currentRootUuid()
		const parent = normalizeParentUuid(base.data.parent, rootUuid)
		const original = driveItemName(base)
		const taken = (name: string) => sdkApi.nameExistsInDirectory(parent, name)

		setPending(true)

		try {
			const name =
				prompt.kind === "deleted" && !(await taken(original))
					? original
					: await conflictCopyName(original, new Date(), args => t("previewConflictCopyName", args), taken)
			const outcome = await runPreviewSave(
				{ uploadFileBytes: (...args) => sdkApi.uploadFileBytes(...args), patchListing: driveListingQueryUpdate, rootUuid },
				{ item, content, asNewFile: name }
			)

			if (outcome.status === "error") {
				toast.error(errorLabel(outcome.dto))

				return
			}

			// The newest question about the slot, as a revision may have arrived during the upload.
			const newest = promptRef.current?.frozenUuid === prompt.frozenUuid ? promptRef.current : prompt

			dropBuffer()
			commitSaved(prompt.frozenUuid, newest.kind === "revised" ? newest.theirs : outcome.item)
			setPrompt(null)
			toast.success(t("previewSavedAsNewFile", { name }))
		} catch (e) {
			log.error("preview", "saving unsaved edits as a new file failed", e)
			toast.error(t("previewSaveAsNewFileFailed"))
		} finally {
			setPending(false)
		}
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
