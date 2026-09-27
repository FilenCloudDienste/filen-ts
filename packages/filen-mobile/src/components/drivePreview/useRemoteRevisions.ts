import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import {
	conflictCopyName,
	decideRevision,
	isRevisionOf,
	run,
	settleHeldRevisions,
	type RevisionDecision,
	type RevisionIdentity
} from "@filen/shared"
import type { AnyDirWithContext } from "@filen/sdk-rs"
import { galleryItemKey, type GalleryItemTagged } from "@/components/drivePreview/gallery"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import useSocketStore, { onSocketReconnected } from "@/stores/useSocket.store"
import { driveItemsQueryFindFileInNormalParent } from "@/features/drive/queries/useDriveItems.query"
import { createUnlockedNotices, createUnlockedToaster, whenUnlockedForeground } from "@/lib/unlockedForeground"
import { isTrashParent, unwrapFileMeta, unwrapParentUuid, unwrappedFileIntoDriveItem } from "@/lib/sdkUnwrap"
import events, { type DriveFileGoneReason } from "@/lib/events"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import auth from "@/lib/auth"
import logger from "@/lib/logger"
import type { DriveItem, DriveItemFileExtracted } from "@/types"

type Revision = { item: DriveItem; previousUuid?: string }

type Gone = { uuid: string; reason: DriveFileGoneReason }

// What a check for changes missed during a socket gap found. `current`: nothing newer, and `file` is the file to
// save over (renamed or moved elsewhere, it is followed). `answered`: something was, and the usual prompt or
// follow took it over. `deferred`: the editor's own save was uploading, so it runs once that settles.
// `unknown`: the check could not be made or was overtaken, so nothing is known.
type GapCheck =
	{ kind: "current"; file: DriveItemFileExtracted } | { kind: "answered" } | { kind: "deferred" } | { kind: "unknown"; error?: unknown }

// The socket connection a check covers: none while the socket is down, as changes made until it reconnects
// reach neither the check nor the socket.
function socketConnection(): number | null {
	const socket = useSocketStore.getState()

	return socket.state === "connected" ? socket.connectedAt : null
}

interface UseRemoteRevisionsParams {
	item: GalleryItemTagged
	// The file the editor writes back to (useEditableTarget), null for anything not editable.
	itemToUse: DriveItemFileExtracted | null
	// The directory the editor writes into (useEditableTarget), looked up when not yet known.
	resolveParent: () => Promise<AnyDirWithContext | "sharedInRoot" | null>
	hasEdits: boolean
	// True while the editor's own save is uploading.
	savingRef: { current: boolean }
	// Writes the unsaved edits to a new file named `name` beside this one; the new file, or null.
	saveAsNewFile: (name: string) => Promise<DriveItemFileExtracted | null>
}

function identityOf(item: DriveItem): RevisionIdentity {
	return { uuid: item.data.uuid, stableUuid: item.type === "file" ? item.data.stableUuid : undefined }
}

function isFile(item: DriveItem): item is DriveItemFileExtracted {
	return item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile"
}

// Keeps an open text or PDF editor on the latest version of its file, and asks before that would lose
// unsaved edits — mobile's side of @filen/shared's remote-change rules (remoteChange.ts), with the web
// preview's answers: follow a newer version saved elsewhere (saying so), or ask Keep mine / Load theirs /
// Save mine as copy; over a deletion elsewhere, Save as new file / Discard. Following swaps the gallery's
// item exactly as a save does (driveItemUpdated), which reloads the editor on the new version. The editor
// reports its own saves (saveSettled), so a save from this device never reads as someone else's.
export default function useRemoteRevisions({
	item,
	itemToUse,
	resolveParent,
	hasEdits,
	savingRef,
	saveAsNewFile
}: UseRemoteRevisionsParams) {
	const { t } = useTranslation()
	const latest = useRef({ item, itemToUse, resolveParent, hasEdits, saveAsNewFile, t })
	const keptOver = useRef<string | undefined>(undefined)
	const held = useRef<Revision[]>([])
	// A deletion that arrived while the editor's own save was uploading, judged once it settles.
	const heldGone = useRef<Gone | null>(null)
	// True from a prompt opening until its answer is carried out, a copy upload included.
	const asking = useRef(false)
	// The newest revision and deletion that arrived meanwhile, acted on after.
	const pending = useRef<{ revision: Revision | null; gone: Gone | null }>({ revision: null, gone: null })
	// The revision the open prompt asks about.
	const askedAbout = useRef<string | undefined>(undefined)
	// A deletion of the file while it had no edits: asked about once it gets some, as saving them would make
	// the file anew (or, after a replacement, a version of the file now holding its name).
	const goneWhileClean = useRef<Gone | null>(null)
	// The last file restored from the trash, so a deletion prompt still waiting to show is dropped.
	const restoredSince = useRef<string | null>(null)
	// Counts what changed the file's known versions (revisions and deletions of it, saves), so a re-read
	// that raced one is dropped rather than taken for news.
	const changes = useRef(0)
	// A socket-gap re-check the editor's own save got in the way of, run once that save settles.
	const recheckAfterSave = useRef(false)
	// The socket connection the last completed gap check covered (null: none), and the check under way, shared
	// by the reconnect and a save waiting on it: one read per gap.
	const gapChecked = useRef<number | null>(socketConnection())
	const gapCheck = useRef<{ connection: number | null; outcome: Promise<GapCheck> } | null>(null)
	// How the file on screen ended while this editor had it (its lineage), so a save that then lands on
	// another lineage is explained truthfully; `acknowledged` once the user answered the prompt about it.
	const lineageEnded = useRef<{ lineage: string | undefined; reason: DriveFileGoneReason | "moved"; acknowledged: boolean } | null>(null)
	// Set by the subscription below, which holds everything the settlement needs.
	const settleRef = useRef<(savedItem: DriveItemFileExtracted | null) => void>(() => undefined)
	const askIfGoneRef = useRef<() => void>(() => undefined)
	const beforeSaveRef = useRef<() => Promise<DriveItemFileExtracted | null>>(() => Promise.resolve(null))

	useEffect(() => {
		latest.current = { item, itemToUse, resolveParent, hasEdits, saveAsNewFile, t }
	})

	useEffect(() => {
		let unmounted = false

		function isCurrent(): boolean {
			const current = useDrivePreviewStore.getState().currentItem

			return current !== null && galleryItemKey(current) === galleryItemKey(latest.current.item)
		}

		// Toasts wait for the unlock, the latest only, and none once this editor is gone.
		const toaster = createUnlockedToaster(message => {
			alerts.normal(message)
		})

		function notify(kind: string, message: string): void {
			toaster.notify(kind, message)
		}

		// A notice that must be read whole: a native alert rather than a one-line toast.
		const announce = createUnlockedNotices(async (title, message) => {
			await prompts.info({ title, message })
		})

		function show(from: DriveItemFileExtracted, to: DriveItem, toast: boolean): void {
			keptOver.current = undefined
			goneWhileClean.current = null
			lineageEnded.current = null

			events.emit("driveItemUpdated", { previousUuid: from.data.uuid, item: to })

			// What the editor follows now, until it re-renders on it.
			if (isFile(to)) {
				latest.current = { ...latest.current, item: { type: "drive", data: to }, itemToUse: to, hasEdits: false }
			}

			if (toast) {
				notify("updated", latest.current.t("remote_change_updated"))
			}
		}

		// "Is this name free beside the file?" A save onto a taken name would make a new version of that
		// other file instead.
		async function nameTaken(name: string): Promise<boolean> {
			const parent = await latest.current.resolveParent()

			// No name can be judged free without a directory to look in, and conflictCopyName would try forever.
			if (parent === null || parent === "sharedInRoot") {
				throw new Error("Missing parent directory")
			}

			const { authedSdkClient } = await auth.getSdkClients()

			return (await authedSdkClient.findItemInDir(parent, name)) !== undefined
		}

		// The copy is an upload from the same editor as a save, so it takes the save's slot: two uploads
		// share one write target.
		async function saveMineAsNewFile(original: string, keepName: boolean): Promise<DriveItemFileExtracted | null> {
			if (savingRef.current) {
				return null
			}

			savingRef.current = true

			try {
				const { t } = latest.current
				const name =
					keepName && !(await nameTaken(original))
						? original
						: await conflictCopyName(original, new Date(), args => t("remote_change_copy_name", args), nameTaken)
				const saved = await latest.current.saveAsNewFile(name)

				if (saved !== null) {
					notify("savedAsNew", t("remote_change_saved_as_new", { name }))
				}

				return saved
			} finally {
				savingRef.current = false
				// What arrived during the copy is judged now: the copy is another file, none of it its echo.
				settleRef.current(null)
			}
		}

		// Whether a prompt's answer still has its editor: the preview may have closed, or the pager recycled
		// it for another file, while the prompt was open.
		function answerable(key: string): boolean {
			return !unmounted && galleryItemKey(latest.current.item) === key
		}

		function resumePending(): void {
			const { revision, gone } = pending.current

			pending.current = { revision: null, gone: null }

			if (unmounted) {
				return
			}

			if (revision !== null) {
				handleRevision(revision)
			}

			if (gone !== null) {
				void handleGone(gone)
			}
		}

		async function ask(displayed: DriveItemFileExtracted, theirs: Revision): Promise<void> {
			const { t } = latest.current
			const name = displayed.data.decryptedMeta?.name ?? ""
			const key = galleryItemKey(latest.current.item)

			asking.current = true
			askedAbout.current = theirs.item.data.uuid

			try {
				// A native alert, with the file's name, would draw over the biometric lock.
				await whenUnlockedForeground()

				if (!answerable(key)) {
					return
				}

				const answer = await run(async () =>
					// Dismissing the alert is its cancel, so Keep mine, which loses nothing, sits there.
					prompts.confirm3({
						title: t("remote_change_title"),
						message: t("remote_change_message", { name }),
						primaryText: t("remote_change_save_copy"),
						destructiveText: t("remote_change_load_theirs"),
						cancelText: t("remote_change_keep_mine")
					})
				)

				if (!answerable(key)) {
					return
				}

				if (!answer.success) {
					logger.error("drivePreview", "remote-change prompt failed", { error: answer.error })
					alerts.error(answer.error)

					return
				}

				// A newer version that arrived meanwhile is asked about next (resumePending).
				if (answer.data === "cancel") {
					keptOver.current = theirs.item.data.uuid

					return
				}

				if (answer.data === "primary") {
					const saved = await run(async () => saveMineAsNewFile(name, false))

					if (!saved.success || saved.data === null) {
						if (!saved.success) {
							alerts.error(saved.error)
						}

						// Nothing was written, so the edits stay where they are, kept over this version.
						keptOver.current = theirs.item.data.uuid

						return
					}
				}

				// Theirs is the newest version by now, not necessarily the one asked about.
				const newest = pending.current.revision ?? theirs

				pending.current.revision = null
				show(displayed, newest.item, false)
			} finally {
				asking.current = false
				askedAbout.current = undefined
				resumePending()
			}
		}

		// Whether `uuid` names the file on screen as the server has it: the version shown, a newer one kept
		// over or asked about, or one waiting for that answer.
		function isOfShownFile(displayed: DriveItemFileExtracted, uuid: string): boolean {
			return (
				uuid === displayed.data.uuid ||
				uuid === keptOver.current ||
				uuid === askedAbout.current ||
				uuid === pending.current.revision?.item.data.uuid
			)
		}

		// `saving` overrides the editor's own flag while its settlement runs, still inside that save, or before its
		// upload starts. Answers what became of the revision.
		function handleRevision(revision: Revision, saving = savingRef.current): "unrelated" | "pending" | RevisionDecision["type"] {
			const { itemToUse: displayed, hasEdits: dirty } = latest.current

			if (
				displayed === null ||
				!isRevisionOf(identityOf(displayed), { ...identityOf(revision.item), previousUuid: revision.previousUuid })
			) {
				return "unrelated"
			}

			changes.current++

			if (asking.current) {
				pending.current.revision = revision

				return "pending"
			}

			const decision = decideRevision({
				current: isCurrent(),
				dirty,
				saving,
				keptOver: keptOver.current,
				revisionUuid: revision.item.data.uuid
			})

			switch (decision.type) {
				case "ignore":
					break
				case "hold":
					held.current.push(revision)

					break
				case "ask":
					void ask(displayed, revision)

					break
				case "show":
					show(displayed, revision.item, decision.announce)

					break
			}

			return decision.type
		}

		// `saving` as in handleRevision.
		async function handleGone(gone: Gone, saving = savingRef.current): Promise<void> {
			const { itemToUse: displayed, hasEdits: dirty, t } = latest.current
			const { uuid, reason } = gone

			if (displayed === null || !isOfShownFile(displayed, uuid) || !isCurrent()) {
				return
			}

			changes.current++
			restoredSince.current = null
			lineageEnded.current = { lineage: identityOf(displayed).stableUuid, reason, acknowledged: false }

			if (!dirty) {
				goneWhileClean.current = gone

				return
			}

			goneWhileClean.current = null

			if (asking.current) {
				pending.current.gone = gone

				return
			}

			// Judged against what the save made, once it settles.
			if (saving) {
				heldGone.current = gone

				return
			}

			const name = displayed.data.decryptedMeta?.name ?? ""
			const key = galleryItemKey(latest.current.item)

			asking.current = true
			askedAbout.current = uuid

			try {
				await whenUnlockedForeground()

				if (!answerable(key) || restoredSince.current === uuid) {
					return
				}

				const answer = await run(async () =>
					prompts.confirm3({
						title: t(reason === "replaced" ? "remote_replaced_title" : "remote_deleted_title"),
						message: t(reason === "replaced" ? "remote_replaced_message" : "remote_deleted_message", { name }),
						primaryText: t("remote_deleted_save_new"),
						destructiveText: t("remote_deleted_discard"),
						cancelText: t("cancel")
					})
				)

				if (!answerable(key)) {
					return
				}

				if (!answer.success) {
					alerts.error(answer.error)

					return
				}

				// Told, the user keeps editing: a save then going to a new file, or into the replacing one, is no news.
				if (lineageEnded.current !== null) {
					lineageEnded.current.acknowledged = true
				}

				if (answer.data === "destructive") {
					pending.current = { revision: null, gone: null }
					latest.current = { ...latest.current, hasEdits: false }
					// Leaving the preview must not ask again about edits just discarded, nor offer to save them.
					useDrivePreviewStore.getState().setHasUnsavedEdits(false)
					events.emit("driveItemRemoved", { uuid })

					return
				}

				if (answer.data === "primary") {
					const saved = await run(async () => saveMineAsNewFile(name, true))

					if (!saved.success) {
						alerts.error(saved.error)

						return
					}

					if (saved.data !== null) {
						show(displayed, saved.data, false)
					}
				}
			} finally {
				asking.current = false
				askedAbout.current = undefined
				resumePending()
			}
		}

		// Whether `from` and `to` are the same version of a file in different directories: a move elsewhere.
		function isMove(from: DriveItemFileExtracted, to: DriveItem): to is DriveItemFileExtracted {
			return (
				isFile(to) &&
				to.data.uuid === from.data.uuid &&
				from.type === "file" &&
				to.type === "file" &&
				unwrapParentUuid(to.data.parent) !== unwrapParentUuid(from.data.parent)
			)
		}

		// Looks the file on screen up once in its directory (changes a socket gap hid never arrive as events), and
		// answers anything newer or gone as if its event had arrived, with no upload of this editor under way:
		// it runs ahead of the editor's own upload, or after it settled.
		async function check(): Promise<GapCheck> {
			const { itemToUse: displayed } = latest.current

			if (displayed === null) {
				return { kind: "unknown" }
			}

			const stableUuid = displayed.type === "file" ? displayed.data.stableUuid : undefined
			const parentUuid = displayed.type === "file" ? unwrapParentUuid(displayed.data.parent) : null

			// Only an own file's directory can be looked in, and only such a file is saved.
			if (stableUuid === undefined || parentUuid === null || !isCurrent()) {
				return { kind: "current", file: displayed }
			}

			const key = galleryItemKey(latest.current.item)
			const seen = changes.current
			// Not overtaken by an event of this file, which the socket, back since, handled itself.
			const fresh = () => answerable(key) && changes.current === seen

			const lookedUp = await run(
				async () => await driveItemsQueryFindFileInNormalParent(parentUuid, stableUuid, displayed.data.decryptedMeta?.name)
			)

			if (!lookedUp.success) {
				logger.warn("drivePreview", "checking the open file after a socket gap failed", { error: lookedUp.error })

				return { kind: "unknown", error: lookedUp.error }
			}

			if (!fresh()) {
				return { kind: "unknown" }
			}

			const { lineage: found, sameName } = lookedUp.data

			if (found !== undefined && isFile(found)) {
				if (found.data.uuid === displayed.data.uuid) {
					// Renamed elsewhere: followed, and a save writes under the new name.
					if (found.data.decryptedMeta?.name !== displayed.data.decryptedMeta?.name) {
						events.emit("driveItemUpdated", { previousUuid: found.data.uuid, item: found })
					}

					return { kind: "current", file: found }
				}

				// A newer version: asked about over unsaved edits, followed otherwise. The user already kept their
				// edits over this one: saving goes over it, as they chose.
				return handleRevision({ item: found }, false) === "ignore" ? { kind: "current", file: displayed } : { kind: "answered" }
			}

			// Gone from its directory: trashed, deleted, moved, or replaced by another file under its name. The
			// server's current version is the one kept over.
			const serverUuid = keptOver.current ?? displayed.data.uuid
			const lookup = await run(async () => {
				const { authedSdkClient } = await auth.getSdkClients()

				return await authedSdkClient.getFileOptional(serverUuid)
			})

			if (!lookup.success) {
				logger.warn("drivePreview", "checking the open file after a socket gap failed", { error: lookup.error })

				return { kind: "unknown", error: lookup.error }
			}

			if (!fresh()) {
				return { kind: "unknown" }
			}

			if (lookup.data === undefined || isTrashParent(lookup.data.parent)) {
				void handleGone({ uuid: serverUuid, reason: lookup.data === undefined ? "deleted" : "trashed" }, false)

				return { kind: "answered" }
			}

			const movedTo = unwrapParentUuid(lookup.data.parent)

			// Moved elsewhere: a save lands in the new directory. The version on screen is followed there (same
			// uuid, so the editor stays mounted); a version the edits were kept over is not shown, only saved over.
			if (movedTo !== null && movedTo !== parentUuid) {
				const moved = unwrappedFileIntoDriveItem(unwrapFileMeta(lookup.data))

				if (!isFile(moved)) {
					return { kind: "unknown" }
				}

				if (moved.data.uuid === displayed.data.uuid) {
					events.emit("driveItemUpdated", { previousUuid: displayed.data.uuid, item: moved })
				}

				return { kind: "current", file: moved }
			}

			// Still in its directory by the lookup, yet absent from its listing: an archived version, as a
			// replacement leaves it (nothing on the SDK's JS surface marks one archived). Another file holding
			// its name confirms it, and a save under that name would be a version of that other file.
			if (sameName !== undefined && movedTo === parentUuid) {
				void handleGone({ uuid: serverUuid, reason: "replaced" }, false)

				return { kind: "answered" }
			}

			return { kind: "current", file: displayed }
		}

		// One gap check per socket connection: the reconnect and a save waiting on it share it, and a completed
		// check marks the connection covered, until the socket drops and comes back. While the editor's own save
		// uploads, it waits for that save to settle, and is judged against what the save made.
		function checkGap(saving: boolean): Promise<GapCheck> {
			if (saving) {
				recheckAfterSave.current = true

				return Promise.resolve({ kind: "deferred" })
			}

			const connection = socketConnection()
			const running = gapCheck.current

			if (running !== null && running.connection === connection) {
				return running.outcome
			}

			const outcome = check().then(result => {
				if (connection !== null && (result.kind === "current" || result.kind === "answered")) {
					gapChecked.current = connection
				}

				return result
			})

			gapCheck.current = { connection, outcome }

			void outcome.finally(() => {
				if (gapCheck.current?.outcome === outcome) {
					gapCheck.current = null
				}
			})

			return outcome
		}

		const revised = events.subscribe("driveFileRevised", revision => {
			handleRevision(revision)
		})
		const gone = events.subscribe("driveFileGone", payload => {
			void handleGone(payload)
		})
		// Back from the trash before anything was asked: no longer gone.
		const restored = events.subscribe("driveFileRestored", ({ uuid }) => {
			restoredSince.current = uuid

			if (goneWhileClean.current?.uuid === uuid) {
				goneWhileClean.current = null
			}

			if (heldGone.current?.uuid === uuid) {
				heldGone.current = null
			}

			if (pending.current.gone?.uuid === uuid) {
				pending.current.gone = null
			}

			if (lineageEnded.current !== null && latest.current.itemToUse?.data.uuid === uuid) {
				lineageEnded.current = null
			}
		})
		// A move elsewhere of the file on screen (the gallery follows it): a save already uploading lands where the
		// file was, as a new file, which the settlement then says.
		const updated = events.subscribe("driveItemUpdated", ({ previousUuid, item: next }) => {
			const displayed = latest.current.itemToUse

			if (displayed !== null && previousUuid === displayed.data.uuid && isMove(displayed, next) && savingRef.current) {
				lineageEnded.current = { lineage: identityOf(displayed).stableUuid, reason: "moved", acknowledged: false }
			}
		})
		const unsubscribeReconnected = onSocketReconnected(() => {
			void checkGap(savingRef.current)
		})

		// Edits begun on a file deleted elsewhere meanwhile: asked about now, before a save recreates it.
		askIfGoneRef.current = () => {
			const gone = goneWhileClean.current

			if (gone !== null && latest.current.hasEdits) {
				goneWhileClean.current = null

				void handleGone(gone)
			}
		}

		// Before the editor's own upload (its save slot already taken): after a socket gap not yet checked (the
		// socket down, or back but not looked at since), the one check runs first, so a version saved elsewhere
		// meanwhile is asked about before the save goes over it. The file to save over, or null to not upload.
		beforeSaveRef.current = async () => {
			const displayed = latest.current.itemToUse

			if (displayed === null) {
				return null
			}

			const connection = socketConnection()

			if (connection !== null && connection === gapChecked.current) {
				return displayed
			}

			const result = await checkGap(false)

			if (result.kind === "current") {
				return result.file
			}

			// Nothing written over a version not known to be the newest: offline, the upload would fail too.
			if (result.kind === "unknown" && result.error !== undefined) {
				alerts.error(result.error)
			}

			return null
		}

		settleRef.current = (savedItem: DriveItemFileExtracted | null) => {
			const settled = settleHeldRevisions(held.current, savedItem?.data.uuid ?? null, revision => revision.item.data.uuid)
			const gone = heldGone.current
			const savedOver = latest.current.itemToUse
			const lineageBefore = savedOver !== null ? identityOf(savedOver).stableUuid : undefined
			const lineageAfter = savedItem !== null ? identityOf(savedItem).stableUuid : undefined
			const { t } = latest.current

			held.current = []
			heldGone.current = null
			changes.current++

			if (settled.replaced) {
				announce("saveReplaced", t("remote_change_save_replaced_title"), t("remote_change_save_replaced"))
			}

			// The save landed on another lineage: the file on screen ended while it uploaded (deleted, replaced
			// under its name, moved away), and the save made a new file or a version of the replacing one. Said
			// once, as it was, unless the user was already told and saved anyway; the editor follows what the
			// save made either way (below).
			if (savedItem !== null && lineageBefore !== undefined && lineageAfter !== undefined && lineageBefore !== lineageAfter) {
				const ended = lineageEnded.current?.lineage === lineageBefore ? lineageEnded.current : null
				const reason = gone?.reason ?? ended?.reason
				const name = savedItem.data.decryptedMeta?.name ?? ""

				if (ended?.acknowledged !== true) {
					announce(
						"savedElsewhere",
						t("remote_change_saved_elsewhere_title"),
						reason === "replaced"
							? t("remote_change_saved_over_replacement", { name })
							: reason === "moved"
								? t("remote_change_saved_after_move", { name })
								: reason === "trashed" || reason === "deleted"
									? t("remote_change_saved_after_deletion", { name })
									: t("remote_change_saved_as_other_file", { name })
					)
				}
			}

			// Judged against the saved version: this editor, and the gallery's current item, follow it (applySaved).
			if (savedItem !== null) {
				latest.current = { ...latest.current, item: { type: "drive", data: savedItem }, itemToUse: savedItem, hasEdits: false }
				keptOver.current = undefined
				goneWhileClean.current = null
				lineageEnded.current = null
			}

			for (const revision of settled.newer) {
				handleRevision(revision, false)
			}

			if (gone !== null) {
				void handleGone(gone, false)
			}

			if (recheckAfterSave.current) {
				recheckAfterSave.current = false

				void checkGap(false)
			}
		}

		return () => {
			unmounted = true
			toaster.dispose()
			revised.remove()
			gone.remove()
			restored.remove()
			updated.remove()
			unsubscribeReconnected()
		}
	}, [savingRef])

	useEffect(() => {
		if (hasEdits) {
			askIfGoneRef.current()
		}
	}, [hasEdits])

	return {
		// Call inside the editor's own save, its slot taken, before uploading: the file to write over (followed
		// through a rename or move elsewhere), or null to not upload, as a prompt about a change made elsewhere
		// took over (or none could be ruled out).
		beforeSave: async (): Promise<DriveItemFileExtracted | null> => await beforeSaveRef.current(),
		// Call after each save of the editor's own settles, its slot released, with what it made (null when it
		// failed or did not upload), so the revisions that arrived meanwhile are judged: its own echo dropped,
		// and a version saved elsewhere in between reported.
		saveSettled: (savedItem: DriveItemFileExtracted | null) => {
			settleRef.current(savedItem)
		}
	}
}
