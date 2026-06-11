import { run, Semaphore } from "@filen/utils"
import { onlineManager } from "@tanstack/react-query"
import NetInfo from "@react-native-community/netinfo"
import {
	type ParentUuid,
	ParentUuid_Tags,
	ErrorKind,
	AnyDirWithContext,
	AnyDirWithContext_Tags,
	AnyNormalDir,
	AnySharedDir_Tags
} from "@filen/sdk-rs"
import auth from "@/lib/auth"
import secureStore from "@/lib/secureStore"
import offline from "@/features/offline/offline"
import useOfflineStore from "@/features/offline/store/useOffline.store"
import {
	parentCacheKey,
	shouldSkipOfflineSyncForConnection,
	makeSyncError,
	OFFLINE_SYNC_WIFI_ONLY_SECURE_STORE_KEY,
	type OfflineParent,
	type OfflineSyncError
} from "@/features/offline/offlineHelpers"
import {
	unwrapDirMeta,
	unwrapFileMeta,
	unwrappedDirIntoDriveItem,
	unwrappedFileIntoDriveItem,
	unwrapParentUuid,
	type UnwrapDirMetaResult,
	type UnwrapFileMetaResult
} from "@/lib/sdkUnwrap"
import { unwrapSdkError } from "@/lib/sdkErrors"
import { isFileItem } from "@/features/drive/driveSelectors"
import type { DriveItem } from "@/types"

type AuthedSdkClient = Awaited<ReturnType<typeof auth.getSdkClients>>["authedSdkClient"]

// Auto triggers (app start / foreground / reconnect) are coalesced behind this min-interval since
// the last COMPLETED pass; manual triggers (offline-screen sync button / pull-to-refresh) bypass it.
export const AUTO_SYNC_MIN_INTERVAL_MS = 60_000

// One fetched + indexed parent listing, shared by the shared-trees pass and the standalone-files
// pass (deduped by parentCacheKey). A parent that is remotely gone/revoked (FolderNotFound /
// WrongPassword) is positive evidence its stored children are gone; any other listing failure is
// inconclusive — affected items are skipped with a `listing` error and retried next pass.
// Resolution of an own-cloud parent uuid into the AnyDirWithContext the offline metas store, plus
// the ONE-LEVEL trash-containment signal (user decision: one level, not an ancestor walk). The
// backend keeps resolving items INSIDE a trashed directory as alive with a normal Uuid parent-tag
// — only the parent dir's OWN parent-tag reveals the trash — so checking just the item used to
// keep trash-contained offline copies forever.
//   resolved       — parent context built (the account root needs no request and can never be
//                    trashed; any other uuid resolves via ONE getDirOptional, cached per pass)
//   trashContained — the parent dir itself resolved with a Trash parent-tag: the item lives
//                    inside a trashed directory ⇒ trash policy applies (remove the local copy)
//   unresolvable   — no parent uuid, or the parent resolved to undefined (permanently deleted
//                    while the child still resolves — undecidable): callers keep their stored
//                    parent / previous behavior, never guess and never delete
//   failed         — the lookup request itself failed (network): inconclusive, `listing` error,
//                    retried next pass
type OwnParentResolution =
	| {
			status: "resolved"
			parent: OfflineParent
	  }
	| {
			status: "trashContained"
	  }
	| {
			status: "unresolvable"
	  }
	| {
			status: "failed"
			message: string
	  }

// One-per-pass dedup of parent lookups (several trees/standalones can share a parent). Keyed by
// parent uuid; promise-valued so concurrently syncing items share the in-flight request.
type ParentContextCache = Map<string, Promise<OwnParentResolution>>

type ParentListingState =
	| {
			status: "ok"
			files: {
				// byUuid intentionally includes undecryptable entries — existence needs no decrypted
				// name, and an undecryptable meta alone must never cause a deletion (design §5.4).
				byUuid: Map<string, UnwrapFileMetaResult>
				// byName requires a decrypted name; keys are trim().toLowerCase() (backend names are
				// case-insensitively unique per directory).
				byName: Map<string, UnwrapFileMetaResult>
			}
			dirs: {
				byUuid: Map<string, UnwrapDirMetaResult>
			}
	  }
	| {
			status: "gone"
	  }
	| {
			status: "failed"
			message: string
	  }

// The generated bindings model an item's parent as the ParentUuid tagged enum: Uuid(uuid) for a
// real parent directory plus the unit variants Trash/Recents/Favorites/Links. getDirOptional /
// getFileOptional return trashed items with parent = ParentUuid.Trash (permanently deleted items
// resolve to undefined instead), so this single tag check is the trash discriminator for both Dir
// and File lookup results. Trash policy: trashed ⇒ remove the local copy, same as deleted.
function isTrashParent(parent: ParentUuid): boolean {
	return parent.tag === ParentUuid_Tags.Trash
}

// Linked-context items are excluded from sync entirely (no error spam): linked listings are
// unsupported for sync and by-uuid lookups only work on user-owned items. Storing from linked
// contexts keeps working — the stored bytes are simply a snapshot.
function isLinkedParent(parent: OfflineParent): boolean {
	return typeof parent !== "string" && parent.tag === AnyDirWithContext_Tags.Linked
}

// Own-cloud items (Normal-tagged parent context) support getDirOptional/getFileOptional fallbacks
// (move-following, meta rebuild). Shared-in items do not — they use listing-based flows only.
function isOwnCloudParent(parent: OfflineParent): boolean {
	return typeof parent !== "string" && parent.tag === AnyDirWithContext_Tags.Normal
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

// A listing failure that is positive evidence the parent itself is remotely gone (FolderNotFound)
// or its share access was revoked (WrongPassword) — both mean the stored children are gone for us.
function isGoneListingError(error: unknown): boolean {
	const unwrappedSdkError = unwrapSdkError(error)

	if (!unwrappedSdkError) {
		return false
	}

	const kind = unwrappedSdkError.kind()

	return kind === ErrorKind.FolderNotFound || kind === ErrorKind.WrongPassword
}

// Top-level offline sync orchestrator. Decides WHAT changed remotely (pure uuid decisions — file
// uuids rotate on every content change, so there are NO timestamp comparisons anywhere) and
// delegates every filesystem mutation to the lock-taking Offline methods (clearBarrier + per-uuid
// lock + storeMutex), so clearAll/store/sync interleavings stay safe.
//
// Pass modes (design §4.2 — manual ⟹ thorough):
//   - AUTOMATIC passes (app start / foreground / reconnect) are INDEX-ONLY: they trust the offline
//     metas as local truth — reconcileTree performs no per-entry disk stats and the standalone
//     heal stat is skipped. Listing-driven decisions (rename/move/version adoption/deletion) still
//     apply on every pass; external deletion/corruption of stored bytes is detected only on
//     thorough passes or lazily at file access (getLocalFile stats; previews fall back).
//   - THOROUGH passes (user-explicit triggers: offline-screen "Sync now" + pull-to-refresh) are
//     DISK-VERIFIED: reconcileTree stat-checks every tree entry (size-checked for files) and the
//     standalone heal (missing/truncated data re-downloads in place) runs. reconcileTree also
//     self-escalates a single tree to the disk-verified view when leftover .sync-tmp-* temps prove
//     a crashed mutation pass, regardless of the pass mode.
//
// One pass (runPass):
//   1. Gates: abort signal, onlineManager, Wi-Fi-only setting (all passes incl. manual).
//   2. Normal trees (own cloud): one getDirOptional per tree root. undefined/trashed → remove;
//      alive → ONE-LEVEL trash-containment gate (the tree's parent dir resolved via a per-pass
//      cached getDirOptional; a trash-tagged parent ⇒ the tree lives inside a trashed folder ⇒
//      remove — items inside trashed dirs keep resolving alive, so the item's own parent-tag
//      alone misses this); renamed/moved → updateTreeRootMeta (the move re-anchor reuses the
//      gate's parent lookup); then one hash-idempotent reconcileTree (thorough follows the pass
//      mode).
//   3. Shared trees + ALL standalone-file parents: ONE deduped listing per unique parent
//      (listDir/listSharedDir/listInSharedRoot). FolderNotFound/WrongPassword ⇒ children removed;
//      other failures ⇒ `listing` errors, items skipped (NO deletions on errors).
//   4. Standalone files: present byUuid → heal (missing/size-mismatched data re-downloads in
//      place; THOROUGH passes only — automatic passes trust the meta and skip the stat) then
//      rename; vanished → byName version adoption (store new uuid FIRST, remove old only once
//      storeFile reports the new copy durably stored — an aborted store keeps the old copy, no
//      error) → own-cloud getFileOptional move-follow/trash/delete (a move INTO a trash-contained
//      parent counts as trashed) → shared ⇒ remove.
//   5. Broken standalone metas: rebuild own-cloud alive items via getFileOptional (meta rewrite
//      only when the data file exists at the remote meta's exact size, redownload otherwise —
//      wrong-size bytes are never blessed), remove trashed/deleted/trash-contained leftovers.
//      Broken TREE metas analogously via getDirOptional: alive → one reconcileTree rebuilds the
//      meta around the existing bytes (an unreadable meta yields an empty local view in BOTH
//      modes); trashed/deleted/trash-contained/undecidable → removeTreeDirectory.
//   6. Finish: one updateIndex, replace useOfflineStore.syncErrors, stamp lastCompletedAt.
//
// Coalescing: concurrent sync() calls join the in-flight pass; auto passes within
// AUTO_SYNC_MIN_INTERVAL_MS of the last completed pass no-op; manual bypasses the interval.
// A manual sync() that joins an in-flight AUTO pass awaits that index-only pass as-is — no queue,
// no mid-flight upgrade (the next explicit manual trigger gets its thorough pass; lastCompletedAt
// is stamped by the joined pass like any other completion).
export class OfflineSync {
	private readonly syncMutex = new Semaphore(1)
	private inFlight: Promise<void> | null = null
	private lastCompletedAt = 0
	private abortController = new AbortController()

	public cancel(): void {
		this.abortController.abort()
		this.abortController = new AbortController()
	}

	public async sync({ manual }: { manual?: boolean } = {}): Promise<void> {
		if (this.inFlight) {
			// Coalescing join (accepted, do NOT queue): a manual sync() arriving while an AUTO pass
			// is in flight joins that index-only pass without upgrading it to thorough — the user's
			// next explicit trigger runs its own thorough pass. lastCompletedAt semantics are
			// unchanged: the joined pass stamps completion exactly like the pass it is.
			return this.inFlight
		}

		if (!manual && Date.now() - this.lastCompletedAt < AUTO_SYNC_MIN_INTERVAL_MS) {
			return
		}

		// manual ⟹ thorough (design §4.2): user-explicit passes are disk-verified, automatic
		// passes trust the metas.
		this.inFlight = this.runPass({
			thorough: manual === true
		}).finally(() => {
			this.inFlight = null
		})

		return this.inFlight
	}

	// Resolves an own-cloud parent uuid into the AnyDirWithContext the offline metas store: the
	// account root builds the Root context exactly like the drive feature does (no request), any
	// other uuid resolves via ONE getDirOptional — deduped per pass through parentContextCache.
	// The same lookup doubles as the one-level trash-containment check: a parent dir whose OWN
	// parent-tag is Trash means the item lives inside a trashed directory (see OwnParentResolution).
	private async resolveOwnParentContext({
		parentUuid,
		authedSdkClient,
		parentContextCache,
		signal
	}: {
		parentUuid: string | null
		authedSdkClient: AuthedSdkClient
		parentContextCache: ParentContextCache
		signal: AbortSignal
	}): Promise<OwnParentResolution> {
		if (!parentUuid) {
			return {
				status: "unresolvable"
			}
		}

		const root = authedSdkClient.root()

		if (parentUuid === root.uuid) {
			// The account root can never be trashed — no request needed.
			return {
				status: "resolved",
				parent: new AnyDirWithContext.Normal(new AnyNormalDir.Root(root))
			}
		}

		const cached = parentContextCache.get(parentUuid)

		if (cached) {
			return cached
		}

		const resolution = (async (): Promise<OwnParentResolution> => {
			const parentLookup = await run(async () =>
				authedSdkClient.getDirOptional(parentUuid, {
					signal
				})
			)

			if (!parentLookup.success) {
				return {
					status: "failed",
					message: errorMessage(parentLookup.error)
				}
			}

			const parentDir = parentLookup.data

			if (parentDir === undefined) {
				return {
					status: "unresolvable"
				}
			}

			if (isTrashParent(parentDir.parent)) {
				return {
					status: "trashContained"
				}
			}

			return {
				status: "resolved",
				parent: new AnyDirWithContext.Normal(new AnyNormalDir.Dir(parentDir))
			}
		})()

		parentContextCache.set(parentUuid, resolution)

		return resolution
	}

	// Fetches ONE listing per unique parent (deduped by parentCacheKey) using the SDK call that
	// matches the parent's context. Aborted parents simply stay absent from the map — their items
	// are skipped silently this pass.
	private async fetchParentListings({
		parents,
		authedSdkClient,
		signal
	}: {
		parents: OfflineParent[]
		authedSdkClient: AuthedSdkClient
		signal: AbortSignal
	}): Promise<Map<string, ParentListingState>> {
		const uniqueParents = new Map<string, OfflineParent>()

		for (const parent of parents) {
			const key = parentCacheKey(parent)

			if (!uniqueParents.has(key)) {
				uniqueParents.set(key, parent)
			}
		}

		const listings = new Map<string, ParentListingState>()

		await Promise.all(
			Array.from(uniqueParents.entries()).map(async ([key, parent]) => {
				if (signal.aborted) {
					return
				}

				const listResult = await run(async () => {
					if (parent === "sharedInRoot") {
						return await authedSdkClient.listInSharedRoot({
							signal
						})
					}

					switch (parent.tag) {
						case AnyDirWithContext_Tags.Normal: {
							return await authedSdkClient.listDir(parent.inner[0], {
								signal
							})
						}

						case AnyDirWithContext_Tags.Shared: {
							switch (parent.inner[0].dir.tag) {
								case AnySharedDir_Tags.Dir:
								case AnySharedDir_Tags.Root: {
									return await authedSdkClient.listSharedDir(parent.inner[0].dir, parent.inner[0].shareInfo, {
										signal
									})
								}

								default: {
									throw new Error("Unsupported shared directory type for listing")
								}
							}
						}

						default: {
							throw new Error("Unsupported directory type for listing")
						}
					}
				})

				if (!listResult.success) {
					if (isGoneListingError(listResult.error)) {
						listings.set(key, {
							status: "gone"
						})
					} else {
						listings.set(key, {
							status: "failed",
							message: errorMessage(listResult.error)
						})
					}

					return
				}

				const filesByUuid = new Map<string, UnwrapFileMetaResult>()
				const filesByName = new Map<string, UnwrapFileMetaResult>()

				for (const file of listResult.data.files) {
					const unwrapped = unwrapFileMeta(file)

					filesByUuid.set(unwrapped.file.uuid, unwrapped)

					if (unwrapped.meta) {
						filesByName.set(unwrapped.meta.name.trim().toLowerCase(), unwrapped)
					}
				}

				const dirsByUuid = new Map<string, UnwrapDirMetaResult>()

				for (const dir of listResult.data.dirs) {
					const unwrapped = unwrapDirMeta(dir)

					dirsByUuid.set(unwrapped.uuid, unwrapped)
				}

				listings.set(key, {
					status: "ok",
					files: {
						byUuid: filesByUuid,
						byName: filesByName
					},
					dirs: {
						byUuid: dirsByUuid
					}
				})
			})
		)

		return listings
	}

	// One stored own-cloud tree root: by-uuid lookup decides deleted/trashed/renamed/moved, then a
	// single reconcileTree converges the tree contents. The alive path additionally resolves the
	// tree's REMOTE parent once (cached per pass; the account root needs no request) — both the
	// one-level trash-containment gate (a tree whose CONTAINING dir was trashed vanishes from
	// listings while still resolving alive itself) and the move re-anchor reuse that single lookup.
	// A failed lookup (tree or parent) is inconclusive — record a `listing` error and keep
	// everything (NO deletions on errors).
	private async syncNormalTree({
		item,
		parent,
		authedSdkClient,
		parentContextCache,
		thorough,
		signal,
		pushError,
		pushErrors
	}: {
		item: DriveItem
		parent: OfflineParent
		authedSdkClient: AuthedSdkClient
		parentContextCache: ParentContextCache
		thorough: boolean
		signal: AbortSignal
		pushError: (error: OfflineSyncError) => void
		pushErrors: (errors: OfflineSyncError[]) => void
	}): Promise<void> {
		if (item.type !== "directory") {
			return
		}

		const lookup = await run(async () =>
			authedSdkClient.getDirOptional(item.data.uuid, {
				signal
			})
		)

		if (!lookup.success) {
			pushError(
				makeSyncError({
					itemUuid: item.data.uuid,
					topLevelUuid: item.data.uuid,
					name: item.data.decryptedMeta?.name ?? item.data.uuid,
					itemType: item.type,
					kind: "listing",
					message: errorMessage(lookup.error)
				})
			)

			return
		}

		const remoteDir = lookup.data

		if (remoteDir === undefined || isTrashParent(remoteDir.parent)) {
			await offline.removeItem(item)

			return
		}

		// One-level trash containment: the tree itself resolves alive, but its parent dir may sit
		// in trash (trashed dirs keep resolving their children as alive). At most one extra request
		// per tree per pass (deduped via parentContextCache; trees are few — acceptable).
		const remoteParentUuid = unwrapParentUuid(remoteDir.parent)
		const parentResolution = await this.resolveOwnParentContext({
			parentUuid: remoteParentUuid,
			authedSdkClient,
			parentContextCache,
			signal
		})

		if (parentResolution.status === "trashContained") {
			// The containing directory was trashed ⇒ the tree is trash-contained. Trash policy:
			// remove the local copy, exactly like a trashed tree root. No reconcile.
			await offline.removeItem(item)

			return
		}

		if (parentResolution.status === "failed") {
			// The parent's trash state could not be determined — inconclusive, like a failed tree
			// lookup: record a `listing` error, keep everything, retry next pass.
			pushError(
				makeSyncError({
					itemUuid: item.data.uuid,
					topLevelUuid: item.data.uuid,
					name: item.data.decryptedMeta?.name ?? item.data.uuid,
					itemType: item.type,
					kind: "listing",
					message: parentResolution.message
				})
			)

			return
		}

		const unwrapped = unwrapDirMeta(remoteDir)
		let currentItem: DriveItem = item
		let resolvedParent = parent

		// An undecryptable remote meta alone never causes damage: keep reconciling with the stored
		// item (its meta was decryptable at store time) and skip the rename/move handling.
		if (unwrapped.meta) {
			const updated = unwrappedDirIntoDriveItem(unwrapped)
			const nameChanged = item.data.decryptedMeta?.name !== unwrapped.meta.name
			const storedParentUuid = unwrapParentUuid(item.data.parent)
			const parentChanged = storedParentUuid !== remoteParentUuid

			currentItem = updated

			if (nameChanged || parentChanged) {
				if (parentChanged && parentResolution.status === "resolved") {
					// Move-following: re-anchor the stored parent context (reusing the trash-gate
					// lookup — no second request). An unresolvable parent keeps the OLD stored
					// parent — the next pass retries the re-anchor.
					resolvedParent = parentResolution.parent
				}

				await offline.updateTreeRootMeta({
					uuid: item.data.uuid,
					item: updated,
					parent: resolvedParent
				})
			}
		}

		pushErrors(
			await offline.reconcileTree({
				directory: currentItem,
				parent: resolvedParent,
				hideProgress: true,
				skipIndexUpdate: true,
				thorough,
				signal
			})
		)
	}

	// One stored shared-in tree root: shared items support no by-uuid fallbacks, so presence in the
	// parent listing is the only signal. Gone/revoked parent or absence from a clean listing is
	// positive evidence ⇒ remove; any other listing failure ⇒ `listing` error, keep everything.
	private async syncListedTree({
		item,
		parent,
		listingState,
		thorough,
		signal,
		pushError,
		pushErrors
	}: {
		item: DriveItem
		parent: OfflineParent
		listingState: ParentListingState | undefined
		thorough: boolean
		signal: AbortSignal
		pushError: (error: OfflineSyncError) => void
		pushErrors: (errors: OfflineSyncError[]) => void
	}): Promise<void> {
		if (!listingState) {
			// Listing skipped (aborted) — silently leave this tree for the next pass.
			return
		}

		if (listingState.status === "failed") {
			pushError(
				makeSyncError({
					itemUuid: item.data.uuid,
					topLevelUuid: item.data.uuid,
					name: item.data.decryptedMeta?.name ?? item.data.uuid,
					itemType: item.type,
					kind: "listing",
					message: listingState.message
				})
			)

			return
		}

		if (listingState.status === "gone") {
			await offline.removeItem(item)

			return
		}

		const present = listingState.dirs.byUuid.get(item.data.uuid)

		if (!present) {
			await offline.removeItem(item)

			return
		}

		let currentItem = item

		if (present.meta) {
			const updated = unwrappedDirIntoDriveItem(present)

			currentItem = updated

			if (item.data.decryptedMeta && present.meta.name !== item.data.decryptedMeta.name) {
				// Remote rename: refresh the meta item, keep the stored parent (shared items are
				// never move-followed).
				await offline.updateTreeRootMeta({
					uuid: item.data.uuid,
					item: updated,
					parent
				})
			}
		}

		pushErrors(
			await offline.reconcileTree({
				directory: currentItem,
				parent,
				hideProgress: true,
				skipIndexUpdate: true,
				thorough,
				signal
			})
		)
	}

	// Own-cloud by-uuid fallback for a standalone file that vanished from its parent's view
	// (absent from a clean listing, or the parent itself is gone): ONE getFileOptional decides.
	// Moved to another own-cloud directory → re-anchor the stored parent context and keep the copy
	// (renameStandaloneFile rewrites the meta incl. parent and renames the data file when the name
	// changed too) — unless the NEW parent dir itself sits in trash (one-level containment), which
	// means the file was moved into a trashed folder ⇒ remove like any trashed item. Trashed/
	// deleted → remove. Lookup failure → `listing` error, keep everything (retried next pass).
	// Alive but undecryptable → never a deletion signal; keep untouched.
	private async followStandaloneFileByUuid({
		item,
		parent,
		authedSdkClient,
		parentContextCache,
		signal,
		pushError
	}: {
		item: DriveItem
		parent: OfflineParent
		authedSdkClient: AuthedSdkClient
		parentContextCache: ParentContextCache
		signal: AbortSignal
		pushError: (error: OfflineSyncError) => void
	}): Promise<void> {
		const lookup = await run(async () =>
			authedSdkClient.getFileOptional(item.data.uuid, {
				signal
			})
		)

		if (!lookup.success) {
			pushError(
				makeSyncError({
					itemUuid: item.data.uuid,
					topLevelUuid: null,
					name: item.data.decryptedMeta?.name ?? item.data.uuid,
					itemType: item.type,
					kind: "listing",
					message: errorMessage(lookup.error)
				})
			)

			return
		}

		const remoteFile = lookup.data

		if (remoteFile === undefined || isTrashParent(remoteFile.parent)) {
			await offline.removeItem(item)

			return
		}

		const unwrappedRemote = unwrapFileMeta(remoteFile)

		if (!unwrappedRemote.meta) {
			// Alive but undecryptable — never a deletion signal; keep the local copy untouched.
			return
		}

		const updated = unwrappedFileIntoDriveItem(unwrappedRemote)
		const parentResolution = await this.resolveOwnParentContext({
			parentUuid: unwrapParentUuid(remoteFile.parent),
			authedSdkClient,
			parentContextCache,
			signal
		})

		if (parentResolution.status === "trashContained") {
			// Moved INTO a trashed directory: the file vanished from listings for good — remove the
			// local copy instead of re-anchoring it to a parent that lives in trash.
			await offline.removeItem(item)

			return
		}

		// Re-anchor the stored parent context; on an unresolvable/failed parent keep the OLD stored
		// parent — the next pass retries.
		await offline.renameStandaloneFile({
			item: updated,
			parent: parentResolution.status === "resolved" ? parentResolution.parent : parent
		})
	}

	// One stored standalone file. Decision order for a uuid vanished from its (clean) parent
	// listing: byName version adoption → own-cloud by-uuid move-follow/trash/delete → shared ⇒
	// positive evidence of removal. All those decisions are LISTING-driven and run on every pass;
	// only the disk-stat heal below is gated on `thorough`.
	private async syncStandaloneFile({
		item,
		parent,
		listingState,
		authedSdkClient,
		parentContextCache,
		thorough,
		signal,
		pushError
	}: {
		item: DriveItem
		parent: OfflineParent
		listingState: ParentListingState | undefined
		authedSdkClient: AuthedSdkClient
		parentContextCache: ParentContextCache
		thorough: boolean
		signal: AbortSignal
		pushError: (error: OfflineSyncError) => void
	}): Promise<void> {
		if (!isFileItem(item)) {
			return
		}

		if (!listingState) {
			// Listing skipped (aborted) — silently leave this file for the next pass.
			return
		}

		if (listingState.status === "failed") {
			pushError(
				makeSyncError({
					itemUuid: item.data.uuid,
					topLevelUuid: null,
					name: item.data.decryptedMeta?.name ?? item.data.uuid,
					itemType: item.type,
					kind: "listing",
					message: listingState.message
				})
			)

			return
		}

		if (listingState.status === "gone") {
			// A gone/revoked parent is positive evidence only for SHARED items (no by-uuid
			// fallbacks exist on foreign accounts). An OWN-cloud file may have been MOVED elsewhere
			// before its old parent vanished — give it the same by-uuid move-follow that a
			// vanished-from-a-clean-listing file gets before concluding removal.
			if (isOwnCloudParent(parent)) {
				await this.followStandaloneFileByUuid({
					item,
					parent,
					authedSdkClient,
					parentContextCache,
					signal,
					pushError
				})

				return
			}

			await offline.removeItem(item)

			return
		}

		const present = listingState.files.byUuid.get(item.data.uuid)

		if (present) {
			// Alive in place (same uuid ⟹ identical bytes). An undecryptable remote meta falls
			// back to the stored item (same uuid ⟹ same bytes).
			const refreshed = present.meta ? unwrappedFileIntoDriveItem(present) : item
			const currentItem = isFileItem(refreshed) ? refreshed : item

			// Standalone heal — THOROUGH passes only: the missing/truncated-data stat is disk
			// verification, which automatic passes skip (they trust the meta; file access stats
			// lazily via getLocalFile and previews fall back to download). When it runs, heal goes
			// BEFORE rename: the index still reflects pre-pass disk state, and
			// redownloadStandaloneFile already writes the refreshed name + meta — a
			// missing-and-renamed file needs only the one download.
			if (thorough) {
				const localFile = await offline.getLocalFile(item)
				const expectedSize = Number(currentItem.data.decryptedMeta?.size ?? -1)

				// A meta-size mismatch alone is not damage: meta sizes are client-supplied and the
				// remote content can genuinely be shorter than claimed. Bytes matching the RECORDED
				// delivered size (written at store/heal time) are blessed — re-downloading them can
				// only ever produce the same shortfall again, forever. The record read only runs on
				// the already-mismatched path, never for healthy files.
				const needsHeal =
					localFile === null ||
					(localFile.size !== expectedSize &&
						localFile.size !== (await offline.getStandaloneRecordedDiskSize(item.data.uuid)))

				if (needsHeal) {
					const heal = await run(async () =>
						offline.redownloadStandaloneFile({
							item: currentItem,
							parent,
							signal
						})
					)

					if (!heal.success) {
						pushError(
							makeSyncError({
								itemUuid: item.data.uuid,
								topLevelUuid: null,
								name: currentItem.data.decryptedMeta?.name ?? item.data.uuid,
								itemType: item.type,
								kind: "download",
								message: errorMessage(heal.error)
							})
						)
					}

					return
				}
			}

			if (present.meta && item.data.decryptedMeta && present.meta.name !== item.data.decryptedMeta.name) {
				await offline.renameStandaloneFile({
					item: currentItem,
					parent
				})
			}

			return
		}

		// Vanished from a clean listing. (a) Same name under a different uuid ⇒ new version of this
		// file: adopt the new uuid FIRST, drop the old copy only once the new one is durably stored.
		const normalizedName = item.data.decryptedMeta?.name.trim().toLowerCase()
		const nameMatch = normalizedName ? listingState.files.byName.get(normalizedName) : undefined

		if (nameMatch && nameMatch.file.uuid !== item.data.uuid) {
			const newItem = unwrappedFileIntoDriveItem(nameMatch)
			const adoption = await run(async () =>
				offline.storeFile({
					file: newItem,
					parent,
					hideProgress: true,
					skipIndexUpdate: true,
					signal
				})
			)

			if (!adoption.success) {
				pushError(
					makeSyncError({
						itemUuid: item.data.uuid,
						topLevelUuid: null,
						name: item.data.decryptedMeta?.name ?? item.data.uuid,
						itemType: item.type,
						kind: "download",
						message: errorMessage(adoption.error)
					})
				)

				return
			}

			if (!adoption.data) {
				// Aborted mid-download (not an error): nothing was stored for the new uuid, so the
				// old copy MUST survive. The next pass retries the adoption.
				return
			}

			await offline.removeItem(item)

			return
		}

		// (b) No name match. Shared-in items support no by-uuid fallback — vanished from a clean
		// listing is positive evidence the item is gone for us. Own-cloud items get the by-uuid
		// move-follow/trash/delete decision.
		if (!isOwnCloudParent(parent)) {
			await offline.removeItem(item)

			return
		}

		await this.followStandaloneFileByUuid({
			item,
			parent,
			authedSdkClient,
			parentContextCache,
			signal,
			pushError
		})
	}

	// Standalone files/{uuid} dirs whose meta is missing/undecodable: rebuild own-cloud alive items
	// from getFileOptional — a meta rewrite when the data file still exists AT the remote meta's
	// exact size, a full redownload otherwise (no bytes: crash/aborted-adoption residue; wrong-size
	// bytes: partial/stale residue that must never be blessed with a fresh meta); remove trashed/
	// deleted/trash-contained/undecidable leftovers; leave lookup failures for the next pass.
	private async healBrokenStandalones({
		authedSdkClient,
		parentContextCache,
		signal,
		pushError
	}: {
		authedSdkClient: AuthedSdkClient
		parentContextCache: ParentContextCache
		signal: AbortSignal
		pushError: (error: OfflineSyncError) => void
	}): Promise<void> {
		const brokenStandalones = await offline.listBrokenStandaloneUuids()

		await Promise.all(
			brokenStandalones.map(async ({ uuid, hasDataFile, dataFileSize }) => {
				if (signal.aborted) {
					return
				}

				let resolvedName: string | undefined

				const result = await run(async () => {
					const lookup = await run(async () =>
						authedSdkClient.getFileOptional(uuid, {
							signal
						})
					)

					if (!lookup.success) {
						pushError(
							makeSyncError({
								itemUuid: uuid,
								topLevelUuid: null,
								name: uuid,
								itemType: "file",
								kind: "listing",
								message: errorMessage(lookup.error)
							})
						)

						return
					}

					const remoteFile = lookup.data

					if (remoteFile === undefined || isTrashParent(remoteFile.parent)) {
						await offline.removeStandaloneDirectory(uuid)

						return
					}

					const unwrappedRemote = unwrapFileMeta(remoteFile)

					if (!unwrappedRemote.meta) {
						// Alive but undecryptable: with no readable local meta AND no decryptable
						// remote name there is nothing to rebuild a meta around — undecidable, so
						// the orphaned dir is removed (design §5: standalone self-heal).
						await offline.removeStandaloneDirectory(uuid)

						return
					}

					resolvedName = unwrappedRemote.meta.name

					const rebuilt = unwrappedFileIntoDriveItem(unwrappedRemote)
					const parentResolution = await this.resolveOwnParentContext({
						parentUuid: unwrapParentUuid(remoteFile.parent),
						authedSdkClient,
						parentContextCache,
						signal
					})

					if (parentResolution.status === "trashContained") {
						// The file's parent dir sits in trash (one-level containment): the item is
						// trash-contained — remove the leftover dir instead of rebuilding a meta
						// anchored inside trash.
						await offline.removeStandaloneDirectory(uuid)

						return
					}

					if (parentResolution.status !== "resolved") {
						// A broken meta has no stored parent to fall back to — leave the dir for the
						// next pass instead of writing a meta with a guessed parent.
						pushError(
							makeSyncError({
								itemUuid: uuid,
								topLevelUuid: null,
								name: unwrappedRemote.meta.name,
								itemType: "file",
								kind: "listing",
								message: "Could not resolve the parent directory of a broken offline file meta"
							})
						)

						return
					}

					const expectedSize = isFileItem(rebuilt) ? Number(rebuilt.data.decryptedMeta?.size ?? -1) : -1

					if (hasDataFile && dataFileSize === expectedSize) {
						// Bytes exist at the EXPECTED size — the cheap meta rewrite blesses them in
						// place (and corrects a stale on-disk name).
						await offline.renameStandaloneFile({
							item: rebuilt,
							parent: parentResolution.parent
						})
					} else {
						// No bytes on disk (crash/aborted-adoption residue), or bytes whose size
						// diverges from the remote meta (partial download residue) — never bless
						// wrong-size bytes with a fresh meta. Redownload writes bytes AND meta.
						await offline.redownloadStandaloneFile({
							item: rebuilt,
							parent: parentResolution.parent,
							signal
						})
					}
				})

				if (!result.success) {
					pushError(
						makeSyncError({
							itemUuid: uuid,
							topLevelUuid: null,
							name: resolvedName ?? uuid,
							itemType: "file",
							kind: "store",
							message: errorMessage(result.error)
						})
					)
				}
			})
		)
	}

	// Stored tree directories/{uuid} dirs whose meta is missing/empty/undecodable (crash or
	// aborted-pass residue — nothing lists them, so without this they linger invisibly forever):
	// one getDirOptional decides. Alive → rebuild the root item from the remote dir, resolve its
	// parent context, and run ONE reconcileTree over the existing bytes (the unreadable-meta path:
	// empty local view in BOTH pass modes, hash-idempotent download skips healthy bytes, meta
	// rebuilt from the listing — near-free; `thorough` simply follows the pass mode).
	// Trashed/deleted/trash-contained/undecidable → removeTreeDirectory. Lookup failure →
	// `listing` error, dir left for the next pass. Mirrors healBrokenStandalones.
	private async healBrokenTrees({
		authedSdkClient,
		parentContextCache,
		thorough,
		signal,
		pushError,
		pushErrors
	}: {
		authedSdkClient: AuthedSdkClient
		parentContextCache: ParentContextCache
		thorough: boolean
		signal: AbortSignal
		pushError: (error: OfflineSyncError) => void
		pushErrors: (errors: OfflineSyncError[]) => void
	}): Promise<void> {
		const brokenTrees = await offline.listBrokenTreeUuids()

		await Promise.all(
			brokenTrees.map(async uuid => {
				if (signal.aborted) {
					return
				}

				let resolvedName: string | undefined

				const result = await run(async () => {
					const lookup = await run(async () =>
						authedSdkClient.getDirOptional(uuid, {
							signal
						})
					)

					if (!lookup.success) {
						pushError(
							makeSyncError({
								itemUuid: uuid,
								topLevelUuid: uuid,
								name: uuid,
								itemType: "directory",
								kind: "listing",
								message: errorMessage(lookup.error)
							})
						)

						return
					}

					const remoteDir = lookup.data

					if (remoteDir === undefined || isTrashParent(remoteDir.parent)) {
						await offline.removeTreeDirectory(uuid)

						return
					}

					const unwrappedRemote = unwrapDirMeta(remoteDir)

					if (!unwrappedRemote.meta) {
						// Alive but undecryptable: with no readable local meta AND no decryptable
						// remote name there is nothing to rebuild a meta around — undecidable, so the
						// orphaned tree dir is removed (mirrors the broken-standalone policy).
						await offline.removeTreeDirectory(uuid)

						return
					}

					resolvedName = unwrappedRemote.meta.name

					const rebuilt = unwrappedDirIntoDriveItem(unwrappedRemote)
					const parentResolution = await this.resolveOwnParentContext({
						parentUuid: unwrapParentUuid(remoteDir.parent),
						authedSdkClient,
						parentContextCache,
						signal
					})

					if (parentResolution.status === "trashContained") {
						// The tree's parent dir sits in trash (one-level containment): the tree is
						// trash-contained — remove the leftover dir instead of rebuilding it inside
						// trash (would re-download bytes for a trashed tree every pass).
						await offline.removeTreeDirectory(uuid)

						return
					}

					if (parentResolution.status !== "resolved") {
						// A broken meta has no stored parent to fall back to — leave the dir for the
						// next pass instead of writing a meta with a guessed parent.
						pushError(
							makeSyncError({
								itemUuid: uuid,
								topLevelUuid: uuid,
								name: unwrappedRemote.meta.name,
								itemType: "directory",
								kind: "listing",
								message: "Could not resolve the parent directory of a broken offline tree meta"
							})
						)

						return
					}

					pushErrors(
						await offline.reconcileTree({
							directory: rebuilt,
							parent: parentResolution.parent,
							hideProgress: true,
							skipIndexUpdate: true,
							thorough,
							signal
						})
					)
				})

				if (!result.success) {
					pushError(
						makeSyncError({
							itemUuid: uuid,
							topLevelUuid: uuid,
							name: resolvedName ?? uuid,
							itemType: "directory",
							kind: "store",
							message: errorMessage(result.error)
						})
					)
				}
			})
		)
	}

	private async runPass({ thorough }: { thorough: boolean }): Promise<void> {
		await run(
			async defer => {
				await this.syncMutex.acquire()

				defer(() => {
					this.syncMutex.release()
				})

				useOfflineStore.getState().setSyncing(true)

				defer(() => {
					useOfflineStore.getState().setSyncing(false)
				})

				const signal = this.abortController.signal

				if (signal.aborted || !onlineManager.isOnline()) {
					return
				}

				// Respect the "Sync offline files on Wi-Fi only" setting (default off → always sync).
				// Mirrors camera upload: applies to ALL passes including manual ones; only a metered
				// cellular connection is blocked. Skip the NetInfo round-trip when the setting is off.
				const wifiOnly = (await secureStore.get<boolean>(OFFLINE_SYNC_WIFI_ONLY_SECURE_STORE_KEY)) === true

				if (wifiOnly) {
					const connectionType = (await NetInfo.fetch()).type

					if (
						shouldSkipOfflineSyncForConnection({
							wifiOnly,
							connectionType
						})
					) {
						return
					}
				}

				const errors: OfflineSyncError[] = []

				const pushError = (error: OfflineSyncError): void => {
					if (!errors.some(existing => existing.id === error.id)) {
						errors.push(error)
					}
				}

				const pushErrors = (newErrors: OfflineSyncError[]): void => {
					for (const error of newErrors) {
						pushError(error)
					}
				}

				const [files, { directories: trees }, { authedSdkClient }] = await Promise.all([
					offline.listFiles(),
					offline.listDirectories(),
					auth.getSdkClients()
				])

				const syncableFiles = files.filter(file => !isLinkedParent(file.parent))
				const syncableTrees = trees.filter(tree => !isLinkedParent(tree.parent))
				const normalTrees = syncableTrees.filter(tree => tree.item.type === "directory")
				const listedTrees = syncableTrees.filter(tree => tree.item.type !== "directory")

				// ONE deduped listing per unique parent, shared by the shared-trees pass and the
				// standalone-files pass.
				const parentListings = await this.fetchParentListings({
					parents: [...listedTrees.map(tree => tree.parent), ...syncableFiles.map(file => file.parent)],
					authedSdkClient,
					signal
				})

				// ONE deduped getDirOptional per unique parent uuid for the trash-containment gate /
				// re-anchor lookups (several trees and standalones can share a parent).
				const parentContextCache: ParentContextCache = new Map()

				// Unexpected per-item failures (lock/setup errors thrown by the offline methods) are
				// converted into `store` errors so one bad item never aborts the whole pass.
				const runGuarded = async ({
					item,
					topLevelUuid,
					fn
				}: {
					item: DriveItem
					topLevelUuid: string | null
					fn: () => Promise<void>
				}): Promise<void> => {
					if (signal.aborted) {
						return
					}

					const result = await run(fn)

					if (!result.success) {
						pushError(
							makeSyncError({
								itemUuid: item.data.uuid,
								topLevelUuid,
								name: item.data.decryptedMeta?.name ?? item.data.uuid,
								itemType: item.type,
								kind: "store",
								message: errorMessage(result.error)
							})
						)
					}
				}

				await Promise.all([
					...normalTrees.map(async ({ item, parent }) =>
						runGuarded({
							item,
							topLevelUuid: item.data.uuid,
							fn: () =>
								this.syncNormalTree({
									item,
									parent,
									authedSdkClient,
									parentContextCache,
									thorough,
									signal,
									pushError,
									pushErrors
								})
						})
					),
					...listedTrees.map(async ({ item, parent }) =>
						runGuarded({
							item,
							topLevelUuid: item.data.uuid,
							fn: () =>
								this.syncListedTree({
									item,
									parent,
									listingState: parentListings.get(parentCacheKey(parent)),
									thorough,
									signal,
									pushError,
									pushErrors
								})
						})
					),
					...syncableFiles.map(async ({ item, parent }) =>
						runGuarded({
							item,
							topLevelUuid: null,
							fn: () =>
								this.syncStandaloneFile({
									item,
									parent,
									listingState: parentListings.get(parentCacheKey(parent)),
									authedSdkClient,
									parentContextCache,
									thorough,
									signal,
									pushError
								})
						})
					)
				])

				await Promise.all([
					this.healBrokenStandalones({
						authedSdkClient,
						parentContextCache,
						signal,
						pushError
					}),
					this.healBrokenTrees({
						authedSdkClient,
						parentContextCache,
						thorough,
						signal,
						pushError,
						pushErrors
					})
				])

				if (signal.aborted) {
					// Aborted mid-pass (logout/teardown): removeItem already reindexed its own
					// deletions; everything else re-converges next pass. Don't touch the error
					// surface or the completion stamp.
					return
				}

				// Tree reconciles and version adoptions ran with skipIndexUpdate — ONE index rebuild
				// commits the pass.
				await offline.updateIndex()

				// Session error surface is rebuilt every pass (stale errors clear on success).
				useOfflineStore.getState().setSyncErrors(errors)

				this.lastCompletedAt = Date.now()
			},
			{
				throw: true
			}
		)
	}
}

const offlineSync = new OfflineSync()

export default offlineSync
