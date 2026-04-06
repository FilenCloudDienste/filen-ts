import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, queryUpdater } from "@/queries/client"
import auth from "@/lib/auth"
import cache from "@/lib/cache"
import { sortParams } from "@filen/utils"
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
	NonRootDir_Tags
} from "@filen/sdk-rs"
import { type DrivePath, DRIVE_PATH_TYPES } from "@/hooks/useDrivePath"
import { unwrapFileMeta, unwrapDirMeta, unwrappedDirIntoDriveItem, unwrappedFileIntoDriveItem } from "@/lib/utils"
import type { DriveItem } from "@/types"
import offline from "@/lib/offline"
import cameraUpload from "@/lib/cameraUpload"

export const BASE_QUERY_KEY = "useDriveItemsQuery"

export type UseDriveItemsQueryParams = {
	path: Omit<DrivePath, "selectOptions">
}

export type NormalResult = NormalDirsAndFiles & {
	type: "normal"
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

export type Result = NormalResult | SharedRootResult | SharedResult | OfflineResult | undefined

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
				const parent = (() => {
					const root = new AnyNormalDir.Root(authedSdkClient.root())

					if (!params.path.uuid || params.path.uuid.length === 0) {
						return root
					}

					const cachedDir = cache.directoryUuidToAnyNormalDir.get(params.path.uuid)

					if (cachedDir) {
						return cachedDir
					}

					return root
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
				const parent = (() => {
					if (!params.path.uuid || params.path.uuid.length === 0) {
						return null
					}

					const cachedDir = cache.directoryUuidToAnyNormalDir.get(params.path.uuid)

					if (cachedDir) {
						return cachedDir
					}

					return null
				})()

				// If not parent is provided, we need to list the root favorites
				if (!parent) {
					const result = await authedSdkClient.listFavorites(signal)

					return {
						...result,
						type: "normal"
					} satisfies Result
				}

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
				const parent = (() => {
					if (!params.path.uuid || params.path.uuid.length === 0) {
						return undefined
					}

					const cachedDir = cache.directoryUuidToAnySharedDirWithContext.get(params.path.uuid)

					if (cachedDir) {
						return cachedDir
					}

					return undefined
				})()

				if (!parent) {
					const result = await authedSdkClient.listInSharedRoot(signal)

					console.log("sharedIn root result", result.dirs.at(0)?.sharingRole)
					console.log("sharedIn root result", result.files.at(0)?.sharingRole)

					return {
						...result,
						type: "sharedRoot"
					}
				}

				const result: Result = {
					dirs: [],
					files: [],
					type: "shared"
				}

				console.log("sharedIn parent", parent)
				console.log("sharedIn parent shareInfo", parent.shareInfo)

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

			case "sharedOut": {
				const parent = (() => {
					if (!params.path.uuid || params.path.uuid.length === 0) {
						return undefined
					}

					const cachedDir = cache.directoryUuidToAnySharedDirWithContext.get(params.path.uuid)

					if (cachedDir) {
						return cachedDir
					}

					return undefined
				})()

				if (!parent) {
					const result = await authedSdkClient.listOutShared(undefined, signal)

					console.log("sharedOut root result", result.dirs.at(0)?.sharingRole)
					console.log("sharedOut root result", result.files.at(0)?.sharingRole)

					return {
						...result,
						type: "sharedRoot"
					} satisfies Result
				}

				const result: Result = {
					dirs: [],
					files: [],
					type: "shared"
				}

				const { dirs, files } = await authedSdkClient.listSharedDir(parent.dir, parent.shareInfo, signal)

				console.log("sharedOut parent", parent)
				console.log("sharedOut parent shareInfo", parent.shareInfo)

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

			case "trash": {
				const result = await authedSdkClient.listTrash(signal)

				return {
					...result,
					type: "normal"
				} satisfies Result
			}

			case "links": {
				const parent = (() => {
					if (!params.path.uuid || params.path.uuid.length === 0) {
						return null
					}

					const cachedDir = cache.directoryUuidToAnyNormalDir.get(params.path.uuid)

					if (cachedDir) {
						return cachedDir
					}

					return null
				})()

				// If not parent is provided, we need to list the root links
				if (!parent) {
					const result = await authedSdkClient.listLinkedItems(signal)

					return {
						...result,
						type: "normal"
					} satisfies Result
				}

				// If we have a parent dir we can simply list it from the main drive
				const result = await authedSdkClient.listDir(parent, signal)

				return {
					...result,
					type: "normal"
				} satisfies Result
			}

			case "offline": {
				const parent = (() => {
					if (!params.path.uuid || params.path.uuid.length === 0) {
						return null
					}

					const cachedDir = cache.directoryUuidToAnyDirWithContext.get(params.path.uuid)

					if (cachedDir) {
						return cachedDir
					}

					return null
				})()

				const [offlineFiles, offlineDirectories] = await Promise.all([
					!parent ? offline.listFiles() : Promise.resolve([]),
					offline.listDirectories(parent ?? undefined)
				])

				// Offline items are already DriveItems (stored as-is in serialized meta files).
				// Pass them through directly — no SDK type wrapping needed.
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
			// Photos and recents should not contain dirs, we can skip the extra work
			if (params.path.type !== "photos" && params.path.type !== "recents") {
				for (const resultDir of result.dirs) {
					const unwrappedDir = unwrapDirMeta(resultDir)
					const driveItem = unwrappedDirIntoDriveItem(unwrappedDir)

					items.push(driveItem)

					if (unwrappedDir.meta?.name) {
						cache.directoryUuidToName.set(unwrappedDir.uuid, unwrappedDir.meta.name)
					}

					cache.uuidToAnyDriveItem.set(unwrappedDir.uuid, driveItem)

					const normalDir = new AnyNormalDir.Dir(resultDir)

					cache.directoryUuidToAnyNormalDir.set(unwrappedDir.uuid, normalDir)
					cache.directoryUuidToAnyDirWithContext.set(unwrappedDir.uuid, new AnyDirWithContext.Normal(normalDir))
				}
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

	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
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
					} as DrivePath
				},
				updater
			})
		}

		driveItemsQueryUpdate({
			params: {
				path: {
					type: pathType,
					uuid: null
				} as DrivePath
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
