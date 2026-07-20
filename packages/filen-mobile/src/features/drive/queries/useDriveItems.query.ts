import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, queryUpdater } from "@/queries/client"
import auth from "@/lib/auth"
import cache from "@/lib/cache"
import { sortParams, run } from "@filen/utils"
import {
	type File,
	type Dir,
	type SharedDir,
	SharingRole,
	AnyNormalDir,
	AnyNormalDir_Tags,
	AnyDirWithContext,
	type NormalDirsAndFiles,
	type SharedRootDirsAndFiles,
	NonRootDir_Tags,
	type LinkedDirsAndFiles,
	AnyLinkedDir,
	type DirPublicLink,
	ErrorKind
} from "@filen/sdk-rs"
import { type DrivePath, DRIVE_PATH_TYPES } from "@/hooks/useDrivePath"
import { unwrapFileMeta, unwrapDirMeta, unwrappedDirIntoDriveItem, unwrappedFileIntoDriveItem, unwrapParentUuid } from "@/lib/sdkUnwrap"
import { unwrapSdkError } from "@/lib/sdkErrors"
import type { DriveItem } from "@/types"
import offline from "@/features/offline/offline"
import cameraUpload from "@/features/cameraUpload/cameraUpload"
import logger from "@/lib/logger"

export const BASE_QUERY_KEY = "useDriveItemsQuery"

/**
 * Thrown when a listing is requested for a provided (non-root) directory uuid
 * that cannot be resolved — neither cached nor found via the SDK by-uuid lookup.
 * Surfacing this (rather than silently falling back to the context root) puts the
 * query into `isError`, so the screen renders an error/empty state under the
 * requested directory's title instead of the wrong root listing.
 */
export class DriveDirectoryNotFoundError extends Error {
	public constructor(uuid: string) {
		super(`Directory not found: ${uuid}`)

		this.name = "DriveDirectoryNotFoundError"
	}
}

export type UseDriveItemsQueryParams = {
	path: Omit<DrivePath, "selectOptions">
}

export type NormalResult = NormalDirsAndFiles & {
	type: "normal"
}

export type LinkedResult = LinkedDirsAndFiles & {
	type: "linked"
	meta: DirPublicLink | null
}

export type SharedResult = {
	dirs: (SharedDir & {
		sharingRole: SharingRole
	})[]
	files: (File & {
		sharingRole: SharingRole
	})[]
	type: "shared"
}

export type SharedRootResult = SharedRootDirsAndFiles & {
	type: "sharedRoot"
}

export type OfflineResult = {
	dirs: DriveItem[]
	files: DriveItem[]
	type: "offline"
}

export type Result = NormalResult | SharedRootResult | SharedResult | OfflineResult | LinkedResult | undefined

async function fetchSharedDir(
	pathType: "sharedIn" | "sharedOut",
	params: UseDriveItemsQueryParams,
	authedSdkClient: Awaited<ReturnType<typeof auth.getSdkClients>>["authedSdkClient"],
	signal: { signal: AbortSignal } | undefined
): Promise<SharedResult | SharedRootResult> {
	const uuid = params.path.uuid
	const hasUuid = Boolean(uuid && uuid.length > 0)

	// No uuid → list the shared root. A provided uuid is a real shared
	// subdirectory; resolving it requires its cached share context, so a cache
	// miss must surface as not-found rather than silently listing the shared
	// root under the requested directory's title.
	const parent = (() => {
		if (!hasUuid || !uuid) {
			return undefined
		}

		const cachedDir = cache.directoryUuidToAnySharedDirWithContext.get(uuid)

		if (cachedDir) {
			return cachedDir
		}

		throw new DriveDirectoryNotFoundError(uuid)
	})()

	if (!parent) {
		const result =
			pathType === "sharedIn"
				? await authedSdkClient.listInSharedRoot(signal)
				: await authedSdkClient.listOutShared(undefined, signal)

		return {
			...result,
			type: "sharedRoot"
		}
	}

	const result: SharedResult = {
		dirs: [],
		files: [],
		type: "shared"
	}

	const { dirs, files } = await authedSdkClient.listSharedDir(parent.dir, parent.shareInfo, signal)

	for (const resultDir of dirs) {
		result.dirs.push({
			...resultDir,
			sharingRole: parent.shareInfo
		})
	}

	for (const resultFile of files) {
		result.files.push({
			...resultFile,
			sharingRole: parent.shareInfo
		})
	}

	return result
}

export async function fetchData(
	params: UseDriveItemsQueryParams & {
		signal?: AbortSignal
	}
) {
	if (!params.path.type) {
		return []
	}

	const { authedSdkClient } = await auth.getSdkClients()
	const signal = params.signal
		? {
				signal: params.signal
			}
		: undefined

	const result: Result = await (async () => {
		switch (params.path.type) {
			case "drive": {
				const uuid = params.path.uuid

				const parent = await (async () => {
					// No uuid (native-tab nav) or the explicit root uuid → list the user's root.
					if (!uuid || uuid.length === 0 || uuid === cache.rootUuid) {
						return new AnyNormalDir.Root(authedSdkClient.root())
					}

					const cachedDir = cache.directoryUuidToAnyNormalDir.get(uuid)

					if (cachedDir) {
						return cachedDir
					}

					// A provided non-root uuid that's not cached (e.g. tapped from a
					// global-search result). Resolve the real directory by uuid instead
					// of silently falling back to root.
					const dir = await authedSdkClient.getDirOptional(uuid, signal)

					if (!dir) {
						throw new DriveDirectoryNotFoundError(uuid)
					}

					return new AnyNormalDir.Dir(dir)
				})()

				const result = await authedSdkClient.listDir(parent, signal)

				return {
					...result,
					type: "normal"
				} satisfies Result
			}

			case "photos": {
				const config = await cameraUpload.getConfig()

				if (!config.enabled || !config.remoteDir) {
					return {
						dirs: [],
						files: [],
						type: "normal"
					} satisfies Result
				}

				const { dirs: resultDirs, files } = await authedSdkClient.listDirRecursive(
					new AnyDirWithContext.Normal(config.remoteDir),
					undefined,
					signal
				)
				const dirs: Dir[] = []

				for (const resultDir of resultDirs) {
					if (resultDir.tag !== NonRootDir_Tags.Normal) {
						continue
					}

					dirs.push(resultDir.inner[0])
				}

				return {
					dirs,
					files,
					type: "normal"
				} satisfies Result
			}

			case "favorites": {
				const uuid = params.path.uuid

				// No uuid → list the root favorites. A provided uuid is a real
				// subdirectory: resolve it (cache → SDK by-uuid) and list THAT,
				// never silently fall back to the favorites root.
				if (!uuid || uuid.length === 0) {
					const result = await authedSdkClient.listFavorites(signal)

					return {
						...result,
						type: "normal"
					} satisfies Result
				}

				const parent = await (async () => {
					const cachedDir = cache.directoryUuidToAnyNormalDir.get(uuid)

					if (cachedDir) {
						return cachedDir
					}

					const dir = await authedSdkClient.getDirOptional(uuid, signal)

					if (!dir) {
						throw new DriveDirectoryNotFoundError(uuid)
					}

					return new AnyNormalDir.Dir(dir)
				})()

				// If we have a parent dir we can simply list it from the main drive
				const result = await authedSdkClient.listDir(parent, signal)

				return {
					...result,
					type: "normal"
				} satisfies Result
			}

			case "recents": {
				const result = await authedSdkClient.listRecents(signal)

				return {
					...result,
					type: "normal"
				} satisfies Result
			}

			case "sharedIn": {
				return fetchSharedDir("sharedIn", params, authedSdkClient, signal)
			}

			case "sharedOut": {
				return fetchSharedDir("sharedOut", params, authedSdkClient, signal)
			}

			case "trash": {
				const result = await authedSdkClient.listTrash(signal)

				return {
					...result,
					type: "normal"
				} satisfies Result
			}

			case "links": {
				const uuid = params.path.uuid

				// No uuid → list the root linked items. A provided uuid is a real
				// subdirectory: resolve it (cache → SDK by-uuid) and list THAT,
				// never silently fall back to the links root.
				if (!uuid || uuid.length === 0) {
					const result = await authedSdkClient.listLinkedItems(signal)

					return {
						...result,
						type: "normal"
					} satisfies Result
				}

				const parent = await (async () => {
					const cachedDir = cache.directoryUuidToAnyNormalDir.get(uuid)

					if (cachedDir) {
						return cachedDir
					}

					const dir = await authedSdkClient.getDirOptional(uuid, signal)

					if (!dir) {
						throw new DriveDirectoryNotFoundError(uuid)
					}

					return new AnyNormalDir.Dir(dir)
				})()

				// If we have a parent dir we can simply list it from the main drive
				const result = await authedSdkClient.listDir(parent, signal)

				return {
					...result,
					type: "normal"
				} satisfies Result
			}

			case "offline": {
				const uuid = params.path.uuid
				const hasUuid = Boolean(uuid && uuid.length > 0)

				// Resolution rides the offline index itself (fully local), so a fresh offline
				// session can browse nested stored directories without a cached SDK context. A
				// provided uuid absent from the index surfaces as not-found — never the wrong root
				// listing. No uuid → the offline root (its files + the top-level directories).
				if (hasUuid && uuid) {
					if (!(await offline.hasIndexedDirectory(uuid))) {
						throw new DriveDirectoryNotFoundError(uuid)
					}

					const offlineDirectories = await offline.listDirectories({ kind: "uuid", uuid })

					return {
						dirs: offlineDirectories.directories.map(({ item }) => item),
						files: offlineDirectories.files.map(({ item }) => item),
						type: "offline" as const
					}
				}

				const [offlineFiles, offlineDirectories] = await Promise.all([offline.listFiles(), offline.listDirectories(undefined)])

				return {
					dirs: offlineDirectories.directories.map(({ item }) => item),
					files: offlineFiles.map(({ item }) => item),
					type: "offline" as const
				}
			}

			case "linked": {
				if (!params.path.linked) {
					return {
						dirs: [],
						files: [],
						type: "linked",
						meta: null
					} satisfies Result
				}

				const linkedUuid = params.path.uuid

				const parent = (() => {
					// No uuid → the public link's root listing (resolved below via the
					// link info). A provided uuid is a real subdirectory of the link;
					// resolving it requires its cached linked context, so a cache miss
					// must surface as not-found rather than silently listing the link
					// root under the requested directory's title.
					if (!linkedUuid || linkedUuid.length === 0) {
						return null
					}

					const cachedDir = cache.directoryUuidToAnyLinkedDirWithMeta.get(linkedUuid)

					if (cachedDir) {
						return cachedDir
					}

					throw new DriveDirectoryNotFoundError(linkedUuid)
				})()

				if (!parent) {
					const info = await authedSdkClient.getDirPublicLinkInfo(params.path.linked.uuid, params.path.linked.key, signal)

					const meta = {
						...info.link,
						password: params.path.linked?.password
					}

					const result = await run(async () => {
						return authedSdkClient.listLinkedDir(new AnyLinkedDir.Root(info.root), meta, undefined, signal)
					})

					if (!result.success) {
						const unwrappedSdkError = unwrapSdkError(result.error)

						if (unwrappedSdkError?.kind() === ErrorKind.WrongPassword) {
							return {
								dirs: [],
								files: [],
								type: "linked",
								meta: null
							} satisfies Result
						}

						throw result.error
					}

					return {
						...result.data,
						type: "linked",
						meta
					} satisfies Result
				}

				const meta = {
					...parent.meta,
					password: params.path.linked?.password
				}

				const result = await authedSdkClient.listLinkedDir(parent.dir, meta, undefined, signal)

				return {
					...result,
					type: "linked",
					meta
				} satisfies Result
			}

			default: {
				return undefined
			}
		}
	})()

	if (!result) {
		return []
	}

	const items: DriveItem[] = []

	switch (result.type) {
		case "normal": {
			// Photos and recents hide directories from the rendered list, but their
			// subdirectories still need to be CACHED — otherwise downstream consumers
			// (e.g. photo bulk "make available offline") can't resolve a parent dir by
			// uuid and silently no-op. So we always unwrap + populate the cache maps,
			// and only suppress the DISPLAY push for photos/recents.
			const skipDisplay = params.path.type === "photos" || params.path.type === "recents"

			for (const resultDir of result.dirs) {
				const driveItem = unwrappedDirIntoDriveItem(unwrapDirMeta(resultDir))

				if (!skipDisplay) {
					items.push(driveItem)
				}

				cache.cacheNewNormalDir(resultDir, driveItem)
			}

			for (const resultFile of result.files) {
				const driveItem = unwrappedFileIntoDriveItem(unwrapFileMeta(resultFile))

				items.push(driveItem)

				cache.cacheNewFile(resultFile, driveItem)
			}

			break
		}

		case "shared": {
			const sharedOut = params.path.type === "sharedOut"

			for (const resultDir of result.dirs) {
				const driveItem = unwrappedDirIntoDriveItem(unwrapDirMeta(resultDir))

				items.push(driveItem)

				cache.cacheNewSharedDir(resultDir, driveItem, { sharedOut })
			}

			for (const resultFile of result.files) {
				const driveItem = unwrappedFileIntoDriveItem(unwrapFileMeta(resultFile))

				items.push(driveItem)

				cache.cacheNewSharedFile(resultFile, driveItem, { sharedOut })
			}

			break
		}

		case "sharedRoot": {
			for (const resultDir of result.dirs) {
				const driveItem = unwrappedDirIntoDriveItem(unwrapDirMeta(resultDir))

				items.push(driveItem)

				cache.cacheNewSharedRootDir(resultDir, driveItem)
			}

			for (const resultFile of result.files) {
				const driveItem = unwrappedFileIntoDriveItem(unwrapFileMeta(resultFile))

				items.push(driveItem)

				cache.cacheDriveItemReference(driveItem)
			}

			break
		}

		case "offline": {
			// Offline items are already DriveItems — no unwrap/rewrap needed.
			for (const driveItem of result.dirs) {
				items.push(driveItem)

				cache.cacheDriveItemReference(driveItem)
			}

			for (const driveItem of result.files) {
				items.push(driveItem)

				cache.cacheDriveItemReference(driveItem)
			}

			break
		}

		case "linked": {
			for (const resultDir of result.dirs) {
				const driveItem = unwrappedDirIntoDriveItem(unwrapDirMeta(resultDir.inner))

				items.push(driveItem)

				cache.cacheNewLinkedDir(resultDir, driveItem, result.meta)
			}

			for (const resultFile of result.files) {
				const driveItem = unwrappedFileIntoDriveItem(unwrapFileMeta(resultFile))

				items.push(driveItem)

				cache.cacheDriveItemReference(driveItem)
			}
		}
	}

	return items
}

function removeSelectOptionsFromParams(params: UseDriveItemsQueryParams): UseDriveItemsQueryParams {
	if ("selectOptions" in params.path) {
		const { selectOptions: _, ...rest } = params.path

		return {
			path: rest
		}
	}

	return params
}

export function useDriveItemsQuery(
	params: UseDriveItemsQueryParams,
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const sortedParams = removeSelectOptionsFromParams(sortParams(params))

	// The offline branch of fetchData reads only from the local offline.* store
	// and never touches the network — it must not be paused by TanStack's
	// "offlineFirst" gating. All other path types use the global default.
	const networkMode = params.path.type === "offline" ? "always" : DEFAULT_QUERY_OPTIONS.networkMode

	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		networkMode,
		...options,
		queryKey: [BASE_QUERY_KEY, sortedParams],
		queryFn: ({ signal }) =>
			fetchData({
				...sortedParams,
				signal
			})
	})

	return query as UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error>
}

export function driveItemsQueryUpdate({
	updater,
	params
}: {
	params: Parameters<typeof fetchData>[0]
} & {
	updater:
		| Awaited<ReturnType<typeof fetchData>>
		| ((prev: Awaited<ReturnType<typeof fetchData>>) => Awaited<ReturnType<typeof fetchData>>)
}): void {
	const sortedParams = removeSelectOptionsFromParams(sortParams(params))

	queryUpdater.set<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY, sortedParams], prev => {
		const currentData = prev ?? ([] satisfies Awaited<ReturnType<typeof fetchData>>)
		const next = typeof updater === "function" ? updater(currentData) : updater

		// Keep the caches in sync with the optimistic listing update — the notes/chats pattern, but
		// richer: a DriveItem carries its SDK type (item.data) and a type discriminator, so cacheDriveItem
		// derives EVERY cache the item's type allows (uuid→item + the type-specific dir/file caches) in one
		// place, shared with fetchData via the same cacheNew* helpers. Context-only extras (the sharedOut
		// normal-view, linked meta) stay with fetchData — see cacheDriveItem.
		for (const item of next) {
			cache.cacheDriveItem(item)
		}

		return next
	})
}

/**
 * Patch the drive listing for a parent that's known to be a normal directory
 * (own / non-shared). Handles the root special case: the drive-root view can be
 * keyed either by `uuid: rootUuid` (deep-link or startScreen) or `uuid: null`
 * (native-tab nav lands at `/tabs/drive/` with no segment). Optimistic adds at
 * root must hit BOTH keys or the listing won't refresh until pull-to-refresh.
 *
 * Use from upload completion, createDirectory, restore, move-destination, and
 * the socket FileNew / FolderSubCreated / FileMove / FolderMove handlers.
 */
export function driveItemsQueryUpdateForNormalParent({
	parentUuid,
	updater
}: {
	parentUuid: string
	updater:
		| Awaited<ReturnType<typeof fetchData>>
		| ((prev: Awaited<ReturnType<typeof fetchData>>) => Awaited<ReturnType<typeof fetchData>>)
}): void {
	driveItemsQueryUpdate({
		params: { path: { type: "drive", uuid: parentUuid } },
		updater
	})

	// Mirror to the `uuid: null` key when the parent is the user's root, since
	// the root listing is observed under either key depending on entry path.
	if (cache.rootUuid && parentUuid === cache.rootUuid) {
		driveItemsQueryUpdate({
			params: { path: { type: "drive", uuid: null } },
			updater
		})
	}
}

export function driveItemsQueryUpdateGlobal({
	updater,
	parentUuid
}: {
	updater:
		| Awaited<ReturnType<typeof fetchData>>
		| ((prev: Awaited<ReturnType<typeof fetchData>>) => Awaited<ReturnType<typeof fetchData>>)
	parentUuid: string
}): void {
	for (const pathType of DRIVE_PATH_TYPES) {
		if (parentUuid) {
			driveItemsQueryUpdate({
				params: {
					path: {
						type: pathType,
						uuid: parentUuid
					}
				},
				updater
			})
		}

		driveItemsQueryUpdate({
			params: {
				path: {
					type: pathType,
					uuid: null
				}
			},
			updater
		})
	}

	driveItemsQueryUpdateForPhotos({ updater })
}

// Walks the cached directory tree up from `parentUuid`, reporting whether it is the camera-upload root
// or a descendant of it. Gates the APPEND into the recursive photos query so a file uploaded OUTSIDE
// the camera-upload subtree is never wrongly inserted there (it would otherwise linger until the query
// next refetches). Bails to false on an uncached ancestor — a miss (the item just shows on the next
// fetch) is acceptable; a false insert is not.
function isUnderCameraUploadRoot(parentUuid: string, rootUuid: string): boolean {
	let current: string | null = parentUuid
	let guard = 0

	while (current && guard++ < 64) {
		if (current === rootUuid) {
			return true
		}

		const anyDir = cache.directoryUuidToAnyNormalDir.get(current)

		if (!anyDir || anyDir.tag !== AnyNormalDir_Tags.Dir) {
			return false
		}

		const next = unwrapParentUuid(anyDir.inner[0].parent)

		if (!next || next === current) {
			return false
		}

		current = next
	}

	return false
}

// Optimistically update the recursive photos-grid query. It is a SEPARATE query from any `drive`
// listing — keyed by the camera-upload root (`{ type: "photos", uuid: <remoteDir> }`) and populated by
// listDirRecursive over that whole subtree — so a mutation that should surface in Photos must be
// mirrored here explicitly.
//
// Pass `parentUuid` when APPENDING a newly-created item: the write then only fires if that parent is
// the camera-upload root or a descendant, so a file uploaded elsewhere is never wrongly inserted into
// this recursive query. Omit `parentUuid` for map/filter updaters (e.g. the global updater's metadata/
// trash passes) — those naturally no-op on items not already present in the list.
//
// Fire-and-forget: resolving the camera-upload config is async and a failure just means the grid
// reconciles on its next fetch. No-ops when camera upload has no destination.
export function driveItemsQueryUpdateForPhotos({
	updater,
	parentUuid
}: {
	updater:
		| Awaited<ReturnType<typeof fetchData>>
		| ((prev: Awaited<ReturnType<typeof fetchData>>) => Awaited<ReturnType<typeof fetchData>>)
	parentUuid?: string
}): void {
	cameraUpload
		.getConfig()
		.then(config => {
			if (!config.remoteDir) {
				return
			}

			const rootUuid = config.remoteDir.inner[0].uuid

			if (parentUuid !== undefined && !isUnderCameraUploadRoot(parentUuid, rootUuid)) {
				return
			}

			driveItemsQueryUpdate({
				params: {
					path: {
						type: "photos",
						uuid: rootUuid
					}
				},
				updater
			})
		})
		.catch(err => {
			logger.error("drive", "driveItemsQueryUpdateForPhotos: failed to get camera upload config", { error: err })
		})
}

// Optimistically update the Recents virtual root (`{ type: "recents", uuid: null }`, backed by
// listRecents()). A brand-new file is the most-recent item, so it belongs here alongside its parent's
// `drive` listing — and unlike Photos, Recents is not scoped to a subtree, so ANY new file qualifies
// (no ancestry gate). Do NOT route new files through the global updater instead: that would also append
// them to the favorites / links / sharedIn / sharedOut virtual roots, where an un-favorited, un-shared
// file does not belong.
export function driveItemsQueryUpdateForRecents({
	updater
}: {
	updater:
		| Awaited<ReturnType<typeof fetchData>>
		| ((prev: Awaited<ReturnType<typeof fetchData>>) => Awaited<ReturnType<typeof fetchData>>)
}): void {
	driveItemsQueryUpdate({
		params: {
			path: {
				type: "recents",
				uuid: null
			}
		},
		updater
	})
}

export function driveItemsQueryGet(params: UseDriveItemsQueryParams) {
	const sortedParams = removeSelectOptionsFromParams(sortParams(params))

	return queryUpdater.get<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY, sortedParams])
}

export default useDriveItemsQuery
