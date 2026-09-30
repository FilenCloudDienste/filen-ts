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
import { onSocketReconnected } from "@/stores/useSocket.store"
import { driveItemsQueryFindFileInNormalParent, type FileInNormalParent } from "@/features/drive/queries/useDriveItems.query"
import { unlockedForegroundGate, whenUnlockedForeground } from "@/lib/unlockedForeground"
import {
	isCovered,
	lineageState,
	liveConnection,
	markCovered,
	previewNotice,
	previewToast
} from "@/components/drivePreview/remoteFileState"
import { isTrashParent, unwrapFileMeta, unwrapParentUuid, unwrappedFileIntoDriveItem } from "@/lib/sdkUnwrap"
import events, { type DriveFileGoneReason } from "@/lib/events"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import auth from "@/lib/auth"
import logger from "@/lib/logger"
import type { DriveItem, DriveItemFileExtracted } from "@/types"
import { isFileItem } from "@/features/drive/driveSelectors"

type Revision = { item: DriveItem; previousUuid?: string }

type Gone = { uuid: string; reason: DriveFileGoneReason }

// What a check for changes the socket may have missed found. `current`: nothing newer, and `file` is the file to
// save over (renamed or moved elsewhere, it is followed). `answered`: something was, and the usual prompt or
// follow took it over. `unknown`: the check could not be made or was overtaken, so nothing is known.
// `unknown` with `changing`: the file kept changing under the check's reads, so nothing could be concluded.
type GapCheck =
	{ kind: "current"; file: DriveItemFileExtracted } | { kind: "answered" } | { kind: "unknown"; error?: unknown; changing?: boolean }

interface UseRemoteRevisionsParams {
	item: GalleryItemTagged
	// The file the editor writes back to (useEditableTarget), null for anything not editable.
	itemToUse: DriveItemFileExtracted | null
	// The directory the editor writes into (useEditableTarget), looked up when not yet known.
	resolveParent: (movedTo?: string) => Promise<AnyDirWithContext | "sharedInRoot" | null>
	hasEdits: boolean
	// True while the editor's own save is uploading.
	savingRef: { current: boolean }
	// Writes the unsaved edits to a new file named `name` beside this one; the new file, or null.
	saveAsNewFile: (name: string) => Promise<DriveItemFileExtracted | null>
}

function identityOf(item: DriveItem): RevisionIdentity {
	return { uuid: item.data.uuid, stableUuid: item.type === "file" ? item.data.stableUuid : undefined }
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
	// The socket connection the editor's own upload began under, to judge what its result covers.
	const uploadedUnder = useRef<number | null>(null)
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

		// The lineage of a file, for an own file (the only kind this editor writes).
		function lineageOf(file: DriveItemFileExtracted | null): string | undefined {
			return file !== null ? identityOf(file).stableUuid : undefined
		}

		// Toasts live with the preview, not this editor, which a follow tears down.
		function notify(kind: string, message: string): void {
			previewToast(lineageOf(latest.current.itemToUse) ?? galleryItemKey(latest.current.item), kind, message)
		}

		// Counts this editor's remote-change prompt, pending or on screen, for its file: saves wait for it.
		function promptOpened(): () => void {
			const lineage = lineageOf(latest.current.itemToUse)
			const state = lineage !== undefined ? lineageState(lineage) : null

			if (state !== null) {
				state.asking++
			}

			return () => {
				if (state !== null) {
					state.asking = Math.max(0, state.asking - 1)
				}
			}
		}

		function show(from: DriveItemFileExtracted, to: DriveItem, toast: boolean): void {
			keptOver.current = undefined
			goneWhileClean.current = null
			lineageEnded.current = null

			events.emit("driveItemUpdated", { previousUuid: from.data.uuid, item: to })

			// What the editor follows now, until it re-renders on it.
			if (isFileItem(to)) {
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

		// Holds `asking` (and so saves) for the prompt's lifetime, then replays what arrived meanwhile.
		async function withPrompt(uuid: string, body: (key: string) => Promise<void>): Promise<void> {
			const key = galleryItemKey(latest.current.item)

			asking.current = true
			askedAbout.current = uuid

			const promptClosed = promptOpened()

			try {
				// A native alert, with the file's name, would draw over the biometric lock.
				await whenUnlockedForeground()
				await body(key)
			} finally {
				promptClosed()
				asking.current = false
				askedAbout.current = undefined
				resumePending()
			}
		}

		async function ask(displayed: DriveItemFileExtracted, theirs: Revision): Promise<void> {
			const { t } = latest.current
			const name = displayed.data.decryptedMeta?.name ?? ""

			await withPrompt(theirs.item.data.uuid, async key => {
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
						cancelText: t("remote_change_keep_mine"),
						// The app can lock while this waits for its turn.
						gate: unlockedForegroundGate
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
			})
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

			await withPrompt(uuid, async key => {
				if (!answerable(key) || restoredSince.current === uuid) {
					return
				}

				const answer = await run(async () =>
					prompts.confirm3({
						title: t(reason === "replaced" ? "remote_replaced_title" : "remote_deleted_title"),
						message: t(reason === "replaced" ? "remote_replaced_message" : "remote_deleted_message", { name }),
						primaryText: t("remote_deleted_save_new"),
						destructiveText: t("remote_deleted_discard"),
						cancelText: t("cancel"),
						gate: unlockedForegroundGate
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

						// A new file of this device's, uploaded while the socket is up.
						const copied = lineageOf(saved.data)

						if (copied !== undefined) {
							markCovered(copied, liveConnection(), saved.data.data.uuid)
						}
					}
				}
			})
		}

		// Whether `from` and `to` are the same version of a file in different directories: a move elsewhere.
		function isMove(from: DriveItemFileExtracted, to: DriveItem): to is DriveItemFileExtracted {
			return (
				isFileItem(to) &&
				to.data.uuid === from.data.uuid &&
				from.type === "file" &&
				to.type === "file" &&
				unwrapParentUuid(to.data.parent) !== unwrapParentUuid(from.data.parent)
			)
		}

		// Looks the file on screen up once in its directory (changes the socket may have missed never arrive as
		// events) and answers anything newer or gone as if its event had arrived, with no upload of this editor
		// under way. The read is kept for the file until an editor acts on it, so one torn down meanwhile (by a
		// save or a follow) hands it to the next; a completed check covers the file for the connection it ran in.
		async function check(): Promise<GapCheck> {
			const { itemToUse: displayed } = latest.current

			if (displayed === null) {
				return { kind: "unknown" }
			}

			const stableUuid = displayed.type === "file" ? displayed.data.stableUuid : undefined
			const parentUuid = displayed.type === "file" ? unwrapParentUuid(displayed.data.parent) : null

			// Only an own file's directory can be looked in, and only such a file is saved.
			if (stableUuid === undefined || parentUuid === null) {
				return { kind: "current", file: displayed }
			}

			// Off screen: nothing here can ask. Its first save checks.
			if (!isCurrent()) {
				return { kind: "unknown" }
			}

			const state = lineageState(stableUuid)
			const connection = liveConnection()
			const key = galleryItemKey(latest.current.item)
			const seen = changes.current
			// Not overtaken by an event of this file, which the socket, back since, handled itself.
			const fresh = () => answerable(key) && changes.current === seen

			// A read for this connection an editor torn down did not act on is used, unless the file changed
			// since it began (a newer version, a rename or move, a deletion). With the socket down, every check
			// reads (what changes until it is back reaches nothing else). A read the file changed under is made
			// again, once.
			let lookedUp: Awaited<ReturnType<typeof run<FileInNormalParent>>> | null = null
			let epoch = state.epoch

			for (let attempt = 0; attempt < 2 && lookedUp === null; attempt++) {
				if (
					state.read === null ||
					state.read.answered ||
					connection === null ||
					state.read.connection !== connection ||
					state.read.epoch !== state.epoch
				) {
					const started = {
						connection,
						epoch: state.epoch,
						lookup: driveItemsQueryFindFileInNormalParent(parentUuid, stableUuid, displayed.data.decryptedMeta?.name),
						answered: false
					}

					void started.lookup.then(
						() => {
							started.answered = true
						},
						() => {
							started.answered = true
						}
					)

					state.read = started
				}

				const read = state.read
				const result = await run(async () => await read.lookup)

				if (state.read === read && (!result.success || read.epoch !== state.epoch)) {
					state.read = null
				}

				// Torn down meanwhile: nothing here to act on it, and nothing to read again for.
				if (!answerable(key)) {
					return { kind: "unknown" }
				}

				if (!result.success || read.epoch === state.epoch) {
					lookedUp = result
					epoch = read.epoch
				}
			}

			if (lookedUp === null) {
				return { kind: "unknown", changing: true }
			}

			if (!lookedUp.success) {
				logger.warn("drivePreview", "checking the open file after a socket gap failed", { error: lookedUp.error })

				return { kind: "unknown", error: lookedUp.error }
			}

			if (!fresh()) {
				return { kind: "unknown" }
			}

			// Acted on here, and the next check reads anew.
			state.read = null
			state.recheck = false

			const found = lookedUp.data.lineage

			// Newest for certain, as nothing of the file changed since the read began: marked before acting on it,
			// which may itself change what is known (a follow).
			if (found !== undefined) {
				markCovered(stableUuid, connection, found.data.uuid)
			}

			const result = await answerCheck(displayed, parentUuid, lookedUp.data, fresh)

			// Not in its directory, still the file to save over (moved there, or a version kept over), and still
			// nothing changed since: that version is the newest.
			if (found === undefined && result.kind === "current" && state.epoch === epoch) {
				markCovered(stableUuid, connection, result.file.data.uuid)
			}

			return result
		}

		// Acts on what a check's directory read found.
		async function answerCheck(
			displayed: DriveItemFileExtracted,
			parentUuid: string,
			lookedUp: Awaited<ReturnType<typeof driveItemsQueryFindFileInNormalParent>>,
			fresh: () => boolean
		): Promise<GapCheck> {
			const { lineage: found, sameName } = lookedUp

			if (found !== undefined && isFileItem(found)) {
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

				if (!isFileItem(moved)) {
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

		// A check, unless this editor's own save is uploading: then the file is marked to be checked once the save
		// settles, by this editor or, torn down by the save's follow, the next one.
		function checkGap(saving: boolean): Promise<GapCheck> {
			const lineage = lineageOf(latest.current.itemToUse)

			if (saving) {
				if (lineage !== undefined) {
					lineageState(lineage).recheck = true
				}

				return Promise.resolve({ kind: "unknown" })
			}

			return check()
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
		// Back after a gap: the file on screen is checked now, a clean editor following what changed and one with
		// edits asking. One off screen is checked by its first save.
		const unsubscribeReconnected = onSocketReconnected(() => {
			if (isCurrent()) {
				void checkGap(savingRef.current)
			}
		})
		// A drive event the socket could not read: the file on screen, too, may have changed unseen.
		const missed = events.subscribe("driveChangesMissed", () => {
			if (isCurrent()) {
				void checkGap(savingRef.current)
			}
		})

		// A check a save or a teardown left undone for this file: run by this editor, now that it is here.
		const lineageOnMount = lineageOf(latest.current.itemToUse)

		if (lineageOnMount !== undefined && lineageState(lineageOnMount).recheck && isCurrent() && !savingRef.current) {
			void checkGap(false)
		}

		// Edits begun on a file deleted elsewhere meanwhile: asked about now, before a save recreates it.
		askIfGoneRef.current = () => {
			const gone = goneWhileClean.current

			if (gone !== null && latest.current.hasEdits) {
				goneWhileClean.current = null

				void handleGone(gone)
			}
		}

		// Before the editor's own upload (its save slot already taken). Nothing goes over what a remote-change
		// prompt about the file is (or is about to be) asking. A copy of the file not known to include every
		// change of the live socket connection (read before it, a gap since, or no socket yet) is checked first,
		// with at most the one read of its directory (none when its listing is fresh), so a version saved
		// elsewhere meanwhile is asked about before the save goes over it. The file to save over, or null to not
		// upload.
		beforeSaveRef.current = async () => {
			const displayed = latest.current.itemToUse

			if (displayed === null || unmounted) {
				return null
			}

			const lineage = lineageOf(displayed)

			if (asking.current || (lineage !== undefined && lineageState(lineage).asking > 0)) {
				return null
			}

			const connection = liveConnection()
			let target: DriveItemFileExtracted = displayed

			// Told the file was deleted or replaced, the user saves anyway: the prompt said what that does.
			const toldEnded = lineageEnded.current?.acknowledged === true && lineageEnded.current.lineage === lineage

			// A version the edits were kept over is what the save goes over: known newest, it needs no check either.
			if (lineage !== undefined && !toldEnded && !isCovered(lineage, keptOver.current ?? displayed.data.uuid)) {
				const result = await check()

				// Discarded or closed meanwhile: nothing is saved.
				if (unmounted) {
					return null
				}

				if (result.kind !== "current") {
					// Nothing written over a version not known to be the newest: offline, the upload would fail too.
					// Never silently: the user is told the save did not happen, and why.
					if (result.kind === "unknown" && result.error !== undefined) {
						alerts.error(result.error)
					} else if (result.kind === "unknown" && result.changing === true) {
						alerts.error(latest.current.t("remote_change_save_not_checked"))
					}

					return null
				}

				target = result.file
			}

			uploadedUnder.current = connection

			return target
		}

		settleRef.current = (savedItem: DriveItemFileExtracted | null) => {
			const settled = settleHeldRevisions(held.current, savedItem?.data.uuid ?? null, revision => revision.item.data.uuid)
			const gone = heldGone.current
			const savedOver = latest.current.itemToUse
			const lineageBefore = savedOver !== null ? identityOf(savedOver).stableUuid : undefined
			const lineageAfter = savedItem !== null ? identityOf(savedItem).stableUuid : undefined
			const lineageChanged = lineageBefore !== undefined && lineageAfter !== undefined && lineageBefore !== lineageAfter
			const { t } = latest.current
			const connection = uploadedUnder.current

			held.current = []
			heldGone.current = null
			uploadedUnder.current = null
			changes.current++

			// Only a save into the same file goes over its versions: one that made another file replaced nothing.
			if (settled.replaced && !lineageChanged) {
				previewNotice("saveReplaced", t("remote_change_save_replaced_title"), t("remote_change_save_replaced"))
			}

			// The save landed on another lineage: the file on screen ended while it uploaded (deleted, replaced
			// under its name, moved away), and the save made a new file or a version of the replacing one. Said
			// once, as it was, unless the user was already told and saved anyway; the editor follows what the
			// save made either way (below).
			if (savedItem !== null && lineageChanged) {
				const ended = lineageEnded.current?.lineage === lineageBefore ? lineageEnded.current : null
				const reason = gone?.reason ?? ended?.reason
				const name = savedItem.data.decryptedMeta?.name ?? ""

				if (ended?.acknowledged !== true) {
					previewNotice(
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

			// What the save made is the newest there is, if the socket stayed up through the upload, events after
			// it arriving live. After a gap during the upload, it is checked: here, or by the editor its follow
			// mounts.
			if (savedItem !== null && lineageAfter !== undefined) {
				if (connection !== null && connection === liveConnection()) {
					markCovered(lineageAfter, connection, savedItem.data.uuid)
				} else {
					lineageState(lineageAfter).recheck = true
				}
			}

			const pendingCheck = lineageAfter ?? lineageBefore

			if (pendingCheck !== undefined && lineageState(pendingCheck).recheck && isCurrent()) {
				void checkGap(false)
			}
		}

		return () => {
			unmounted = true
			revised.remove()
			gone.remove()
			restored.remove()
			updated.remove()
			missed.remove()
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
