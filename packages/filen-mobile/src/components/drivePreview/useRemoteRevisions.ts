import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { conflictCopyName, decideRevision, isRevisionOf, run, settleHeldRevisions, type RevisionIdentity } from "@filen/shared"
import type { AnyDirWithContext } from "@filen/sdk-rs"
import { galleryItemKey, type GalleryItemTagged } from "@/components/drivePreview/gallery"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import events from "@/lib/events"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import auth from "@/lib/auth"
import logger from "@/lib/logger"
import type { DriveItem, DriveItemFileExtracted } from "@/types"

type Revision = { item: DriveItem; previousUuid?: string }

interface UseRemoteRevisionsParams {
	item: GalleryItemTagged
	// The file the editor writes back to (useEditableTarget), null for anything not editable.
	itemToUse: DriveItemFileExtracted | null
	parent: AnyDirWithContext | "sharedInRoot" | null
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
export default function useRemoteRevisions({ item, itemToUse, parent, hasEdits, savingRef, saveAsNewFile }: UseRemoteRevisionsParams) {
	const { t } = useTranslation()
	const latest = useRef({ item, itemToUse, parent, hasEdits, saveAsNewFile, t })
	const keptOver = useRef<string | undefined>(undefined)
	const held = useRef<Revision[]>([])
	const asking = useRef(false)
	// Set by the subscription below, which holds everything the settlement needs.
	const settleRef = useRef<(savedItem: DriveItemFileExtracted | null) => void>(() => undefined)

	useEffect(() => {
		latest.current = { item, itemToUse, parent, hasEdits, saveAsNewFile, t }
	})

	useEffect(() => {
		function isCurrent(): boolean {
			const current = useDrivePreviewStore.getState().currentItem

			return current !== null && galleryItemKey(current) === galleryItemKey(latest.current.item)
		}

		function show(from: DriveItemFileExtracted, to: DriveItem, announce: boolean): void {
			events.emit("driveItemUpdated", { previousUuid: from.data.uuid, item: to })

			if (announce) {
				alerts.normal(latest.current.t("remote_change_updated"))
			}
		}

		// "Is this name free beside the file?" A save onto a taken name would make a new version of that
		// other file instead.
		async function nameTaken(name: string): Promise<boolean> {
			const { parent } = latest.current

			if (parent === null || parent === "sharedInRoot") {
				return true
			}

			const { authedSdkClient } = await auth.getSdkClients()

			return (await authedSdkClient.findItemInDir(parent, name)) !== undefined
		}

		async function saveMineAsNewFile(original: string, keepName: boolean): Promise<DriveItemFileExtracted | null> {
			const { t } = latest.current
			const name =
				keepName && !(await nameTaken(original))
					? original
					: await conflictCopyName(original, new Date(), args => t("remote_change_copy_name", args), nameTaken)
			const saved = await latest.current.saveAsNewFile(name)

			if (saved !== null) {
				alerts.normal(t("remote_change_saved_as_new", { name }))
			}

			return saved
		}

		async function ask(displayed: DriveItemFileExtracted, theirs: DriveItem): Promise<void> {
			const { t } = latest.current
			const name = displayed.data.decryptedMeta?.name ?? ""

			asking.current = true

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

			asking.current = false

			if (!answer.success) {
				logger.error("drivePreview", "remote-change prompt failed", { error: answer.error })
				alerts.error(answer.error)

				return
			}

			if (answer.data === "cancel") {
				keptOver.current = theirs.data.uuid

				return
			}

			if (answer.data === "primary") {
				const saved = await run(async () => saveMineAsNewFile(name, false))

				if (!saved.success || saved.data === null) {
					if (!saved.success) {
						alerts.error(saved.error)
					}

					// Nothing was written, so the edits stay where they are, kept over this version.
					keptOver.current = theirs.data.uuid

					return
				}
			}

			show(displayed, theirs, false)
		}

		// `saving` overrides the editor's own flag while its settlement runs, still inside that save.
		function handleRevision(revision: Revision, saving = savingRef.current): void {
			const { itemToUse: displayed, hasEdits: dirty } = latest.current

			if (
				displayed === null ||
				!isRevisionOf(identityOf(displayed), { ...identityOf(revision.item), previousUuid: revision.previousUuid })
			) {
				return
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
					return
				case "hold":
					held.current.push(revision)

					return
				case "ask":
					if (!asking.current) {
						void ask(displayed, revision.item)
					}

					return
				case "show":
					show(displayed, revision.item, decision.announce)

					return
			}
		}

		async function handleGone(uuid: string): Promise<void> {
			const { itemToUse: displayed, hasEdits: dirty, t } = latest.current

			if (displayed?.data.uuid !== uuid || !dirty || !isCurrent() || asking.current) {
				return
			}

			const name = displayed.data.decryptedMeta?.name ?? ""

			asking.current = true

			const answer = await run(async () =>
				prompts.confirm3({
					title: t("remote_deleted_title"),
					message: t("remote_deleted_message", { name }),
					primaryText: t("remote_deleted_save_new"),
					destructiveText: t("remote_deleted_discard"),
					cancelText: t("cancel")
				})
			)

			asking.current = false

			if (!answer.success) {
				alerts.error(answer.error)

				return
			}

			if (answer.data === "destructive") {
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
		}

		const revised = events.subscribe("driveFileRevised", revision => {
			handleRevision(revision)
		})
		const gone = events.subscribe("driveFileGone", ({ uuid }) => {
			void handleGone(uuid)
		})

		settleRef.current = (savedItem: DriveItemFileExtracted | null) => {
			const settled = settleHeldRevisions(held.current, savedItem?.data.uuid ?? null, revision => revision.item.data.uuid)

			held.current = []

			if (settled.replaced) {
				alerts.normal(latest.current.t("remote_change_save_replaced"))
			}

			// Judged against the saved version: this editor is about to follow it (applySaved).
			if (savedItem !== null) {
				latest.current = { ...latest.current, itemToUse: savedItem, hasEdits: false }
			}

			for (const revision of settled.newer) {
				handleRevision(revision, false)
			}
		}

		return () => {
			revised.remove()
			gone.remove()
		}
	}, [savingRef])

	return {
		// Call after each save of the editor's own settles, with what it made (null when it failed), so
		// the revisions that arrived meanwhile are judged: its own echo dropped, and a version saved
		// elsewhere in between reported.
		saveSettled: (savedItem: DriveItemFileExtracted | null) => {
			settleRef.current(savedItem)
		}
	}
}
