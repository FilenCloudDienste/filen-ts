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
	AnySharedDir,
	AnySharedDirWithContext,
	AnyDirWithContext,
	type NormalDirsAndFiles,
	type SharedRootDirsAndFiles,
	NonRootDir_Tags,
	type LinkedDirsAndFiles,
	AnyLinkedDir,
	type DirPublicLink,
	ErrorKind,
	AnyLinkedDirWithContext
} from "@filen/sdk-rs"
import { type DrivePath, DRIVE_PATH_TYPES } from "@/hooks/useDrivePath"
import { unwrapFileMeta, unwrapDirMeta, unwrappedDirIntoDriveItem, unwrappedFileIntoDriveItem } from "@/lib/sdkUnwrap"
import { unwrapSdkError } from "@/lib/sdkErrors"
import type { DriveItem } from "@/types"
import offline from "@/features/offline/offline"
import cameraUpload from "@/features/cameraUpload/cameraUpload"

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

				// No uuid → list the offline root. A provided uuid identifies a real
				// subdirectory; the offline index is keyed by its cached context, so a
				// cache miss must surface as not-found rather than silently listing the
				// whole offline root under the requested directory's title.
				const parent = (() => {
					if (!hasUuid || !uuid) {
						return null
					}

					const cachedDir = cache.directoryUuidToAnyDirWithContext.get(uuid)

					if (cachedDir) {
						return cachedDir
					}

					throw new DriveDirectoryNotFoundError(uuid)
				})()

				const [offlineFiles, offlineDirectories] = await Promise.all([
					!parent ? offline.listFiles() : Promise.resolve([]),
					offline.listDirectories(parent ?? undefined)
				])

				const offlineDirs: DriveItem[] = offlineDirectories.directories.map(({ item }) => item)
				const offlineFileItems: DriveItem[] = parent
					? offlineDirectories.files.map(({ item }) => item)
					: offlineFiles.map(({ item }) => item)

				return {
					dirs: offlineDirs,
					files: offlineFileItems,
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
				const unwrappedDir = unwrapDirMeta(resultDir)
				const driveItem = unwrappedDirIntoDriveItem(unwrappedDir)

				if (!skipDisplay) {
					items.push(driveItem)
				}

				if (unwrappedDir.meta?.name) {
					cache.directoryUuidToName.set(unwrappedDir.uuid, unwrappedDir.meta.name)
				}

				cache.uuidToAnyDriveItem.set(unwrappedDir.uuid, driveItem)

				const normalDir = new AnyNormalDir.Dir(resultDir)

				cache.directoryUuidToAnyNormalDir.set(unwrappedDir.uuid, normalDir)
				cache.directoryUuidToAnyDirWithContext.set(unwrappedDir.uuid, new AnyDirWithContext.Normal(normalDir))
			}

			for (const resultFile of result.files) {
				const unwrappedFile = unwrapFileMeta(resultFile)
				const driveItem = unwrappedFileIntoDriveItem(unwrappedFile)

				items.push(driveItem)

				cache.uuidToAnyDriveItem.set(unwrappedFile.file.uuid, driveItem)
				cache.fileUuidToNormalFile.set(resultFile.uuid, resultFile)
			}

			break
		}

		case "shared": {
			for (const resultDir of result.dirs) {
				const unwrappedDir = unwrapDirMeta(resultDir)
				const driveItem = unwrappedDirIntoDriveItem(unwrappedDir)

				items.push(driveItem)

				if (unwrappedDir.meta?.name) {
					cache.directoryUuidToName.set(unwrappedDir.uuid, unwrappedDir.meta.name)
				}

				cache.uuidToAnyDriveItem.set(unwrappedDir.uuid, driveItem)

				const withContext = AnySharedDirWithContext.new({
					dir: new AnySharedDir.Dir(resultDir),
					shareInfo: resultDir.sharingRole
				})

				cache.directoryUuidToAnySharedDirWithContext.set(unwrappedDir.uuid, withContext)
				cache.directoryUuidToAnyDirWithContext.set(unwrappedDir.uuid, new AnyDirWithContext.Shared(withContext))

				if (params.path.type === "sharedOut") {
					cache.directoryUuidToAnyNormalDir.set(unwrappedDir.uuid, new AnyNormalDir.Dir(resultDir.inner))
				}
			}

			for (const resultFile of result.files) {
				const unwrappedFile = unwrapFileMeta(resultFile)
				const driveItem = unwrappedFileIntoDriveItem(unwrappedFile)

				items.push(driveItem)

				cache.uuidToAnyDriveItem.set(unwrappedFile.file.uuid, driveItem)

				if (params.path.type === "sharedOut") {
					const { sharingRole: _, ...file } = resultFile

					cache.fileUuidToNormalFile.set(unwrappedFile.file.uuid, file)
				}
			}

			break
		}

		case "sharedRoot": {
			for (const resultDir of result.dirs) {
				const unwrappedDir = unwrapDirMeta(resultDir)
				const driveItem = unwrappedDirIntoDriveItem(unwrappedDir)

				items.push(driveItem)

				if (unwrappedDir.meta?.name) {
					cache.directoryUuidToName.set(unwrappedDir.uuid, unwrappedDir.meta.name)
				}

				cache.uuidToAnyDriveItem.set(unwrappedDir.uuid, driveItem)

				const withContext = AnySharedDirWithContext.new({
					dir: new AnySharedDir.Root(resultDir),
					shareInfo: resultDir.sharingRole
				})

				cache.directoryUuidToAnySharedDirWithContext.set(unwrappedDir.uuid, withContext)
				cache.directoryUuidToAnyDirWithContext.set(unwrappedDir.uuid, new AnyDirWithContext.Shared(withContext))
			}

			for (const resultFile of result.files) {
				const unwrappedFile = unwrapFileMeta(resultFile)
				const driveItem = unwrappedFileIntoDriveItem(unwrappedFile)

				items.push(driveItem)

				cache.uuidToAnyDriveItem.set(unwrappedFile.file.uuid, driveItem)
			}

			break
		}

		case "offline": {
			// Offline items are already DriveItems — no unwrap/rewrap needed.
			for (const driveItem of result.dirs) {
				items.push(driveItem)

				cache.uuidToAnyDriveItem.set(driveItem.data.uuid, driveItem)
			}

			for (const driveItem of result.files) {
				items.push(driveItem)

				cache.uuidToAnyDriveItem.set(driveItem.data.uuid, driveItem)
			}

			break
		}

		case "linked": {
			for (const resultDir of result.dirs) {
				const unwrappedDir = unwrapDirMeta(resultDir.inner)
				const driveItem = unwrappedDirIntoDriveItem(unwrappedDir)

				items.push(driveItem)

				cache.uuidToAnyDriveItem.set(unwrappedDir.uuid, driveItem)

				if (unwrappedDir.meta?.name) {
					cache.directoryUuidToName.set(unwrappedDir.uuid, unwrappedDir.meta.name)
				}

				if (result.meta) {
					cache.directoryUuidToAnyLinkedDirWithMeta.set(unwrappedDir.uuid, {
						dir: new AnyLinkedDir.Dir(resultDir),
						meta: result.meta
					})

					cache.directoryUuidToAnyDirWithContext.set(
						unwrappedDir.uuid,
						new AnyDirWithContext.Linked(
							AnyLinkedDirWithContext.new({
								dir: new AnyLinkedDir.Dir(resultDir),
								link: result.meta
							})
						)
					)
				}
			}

			for (const resultFile of result.files) {
				const unwrappedFile = unwrapFileMeta(resultFile)
				const driveItem = unwrappedFileIntoDriveItem(unwrappedFile)

				items.push(driveItem)

				cache.uuidToAnyDriveItem.set(unwrappedFile.file.uuid, driveItem)
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

		return typeof updater === "function" ? updater(currentData) : updater
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

	cameraUpload
		.getConfig()
		.then(config => {
			if (!config.remoteDir) {
				return
			}

			driveItemsQueryUpdate({
				params: {
					path: {
						type: "photos",
						uuid: config.remoteDir.inner[0].uuid
					}
				},
				updater
			})
		})
		.catch(console.error)
}

export function driveItemsQueryGet(params: UseDriveItemsQueryParams) {
	const sortedParams = removeSelectOptionsFromParams(sortParams(params))

	return queryUpdater.get<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY, sortedParams])
}

export default useDriveItemsQuery
