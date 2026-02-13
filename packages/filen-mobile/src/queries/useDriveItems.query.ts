import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, useDefaultQueryParams, queryUpdater } from "@/queries/client"
import auth from "@/lib/auth"
import useRefreshOnFocus from "@/queries/useRefreshOnFocus"
import cache from "@/lib/cache"
import { sortParams } from "@filen/utils"
import {
	DirEnum,
	AnyDirEnumWithShareInfo,
	NonRootItemTagged,
	type File,
	type Dir,
	type SharedDir,
	type SharedFile,
	DirWithMetaEnum_Tags
} from "@filen/sdk-rs"
import { type DrivePath, DRIVE_PATH_TYPES } from "@/hooks/useDrivePath"
import { unwrapFileMeta, unwrapDirMeta, unwrappedDirIntoDriveItem, unwrappedFileIntoDriveItem } from "@/lib/utils"
import type { DriveItem } from "@/types"
import offline from "@/lib/offline"

export const BASE_QUERY_KEY = "useDriveItemsQuery"

export type UseDriveItemsQueryParams = {
	path: DrivePath
}

export async function fetchData(
	params: UseDriveItemsQueryParams & {
		signal?: AbortSignal
	}
) {
	if (!params.path.type) {
		return []
	}

	const sdkClient = await auth.getSdkClient()

	const signal = params.signal
		? {
				signal: params.signal
			}
		: undefined

	const result = await (async () => {
		switch (params.path.type) {
			case "drive": {
				const dir = (() => {
					const root = new DirEnum.Root(sdkClient.root())

					if (!params.path.uuid || params.path.uuid.length === 0) {
						return root
					}

					const cachedDir = cache.directoryUuidToDir.get(params.path.uuid)

					if (cachedDir) {
						return new DirEnum.Dir(cachedDir)
					}

					return root
				})()

				return sdkClient.listDir(dir, signal)
			}

			case "favorites": {
				return sdkClient.listFavorites(signal)
			}

			case "recents": {
				return sdkClient.listRecents(signal)
			}

			case "sharedIn": {
				const dir = (() => {
					if (!params.path.uuid || params.path.uuid.length === 0) {
						return undefined
					}

					const cachedDir = cache.sharedDirUuidToDir.get(params.path.uuid)

					if (cachedDir) {
						return cachedDir.dir
					}

					return undefined
				})()

				return sdkClient.listInShared(dir, signal)
			}

			case "sharedOut": {
				const dir = (() => {
					if (!params.path.uuid || params.path.uuid.length === 0) {
						return undefined
					}

					const cachedDir = cache.sharedDirUuidToDir.get(params.path.uuid)

					if (cachedDir) {
						return cachedDir
					}

					return undefined
				})()

				if (!dir) {
					return sdkClient.listOutShared(undefined, undefined, signal)
				}

				if (dir.sharingRole.inner[0].id === (await sdkClient.toStringified()).userId) {
					return {
						dirs: [],
						files: []
					}
				}

				const contacts = await sdkClient.getContacts(signal)
				const contact = contacts.find(contact => contact.userId === dir.sharingRole.inner[0].id)

				return sdkClient.listOutShared(dir.dir, contact, signal)
			}

			case "trash": {
				return sdkClient.listTrash(signal)
			}

			case "links": {
				const dir = (() => {
					if (!params.path.uuid || params.path.uuid.length === 0) {
						return null
					}

					const cachedDir = cache.directoryUuidToDir.get(params.path.uuid)

					if (cachedDir) {
						return new DirEnum.Dir(cachedDir)
					}

					return null
				})()

				// If not parent is provided, we need to list the root links
				if (!dir) {
					// TODO: wait for sdk list links impl
					return {
						dirs: [],
						files: []
					}
				}

				// If we have a parent dir we can simply list it from the main drive
				return sdkClient.listDir(dir, signal)
			}

			case "offline": {
				const dir = (() => {
					if (!params.path.uuid || params.path.uuid.length === 0) {
						return null
					}

					const cachedDir = cache.directoryUuidToAnyDirWithShareInfo.get(params.path.uuid)

					if (cachedDir) {
						return cachedDir
					}

					return null
				})()

				const [offlineFiles, offlineDirectories] = await Promise.all([
					!dir ? offline.listFiles() : Promise.resolve([]),
					offline.listDirectories(dir ?? undefined)
				])

				const dirs: (Dir | SharedDir)[] = []
				const files: (File | SharedFile)[] = []

				if (offlineDirectories.directories.length > 0) {
					for (const { item } of offlineDirectories.directories) {
						if (item.type !== "directory" && item.type !== "sharedDirectory") {
							continue
						}

						if (item.type === "directory") {
							dirs.push(new NonRootItemTagged.Dir(item.data).inner[0])

							continue
						}

						dirs.push(new AnyDirEnumWithShareInfo.SharedDir(item.data).inner[0])
					}
				}

				if (dir && offlineDirectories.files.length > 0) {
					for (const { item } of offlineDirectories.files) {
						if (item.type !== "file" && item.type !== "sharedFile") {
							continue
						}

						if (item.type === "file") {
							files.push(new NonRootItemTagged.File(item.data).inner[0])

							continue
						}

						files.push(item.data)
					}
				}

				if (!dir && offlineFiles.length > 0) {
					for (const { item } of offlineFiles) {
						if (item.type !== "file" && item.type !== "sharedFile") {
							continue
						}

						if (item.type === "file") {
							files.push(new NonRootItemTagged.File(item.data).inner[0])

							continue
						}

						files.push(item.data)
					}
				}

				return {
					dirs,
					files
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

	for (const resultDir of result.dirs) {
		const unwrappedDir = unwrapDirMeta(resultDir)
		const item = unwrappedDirIntoDriveItem(unwrappedDir)

		cache.directoryUuidToName.set(unwrappedDir.uuid, unwrappedDir.meta?.name ?? unwrappedDir.uuid)
		cache.uuidToDriveItem.set(unwrappedDir.uuid, item)

		if (!unwrappedDir.shared) {
			items.push(item)

			cache.directoryUuidToDir.set(unwrappedDir.uuid, unwrappedDir.dir)
			cache.directoryUuidToAnyDirWithShareInfo.set(unwrappedDir.uuid, new AnyDirEnumWithShareInfo.Dir(unwrappedDir.dir))
		} else {
			items.push(item)

			cache.sharedDirUuidToDir.set(unwrappedDir.uuid, unwrappedDir.dir)

			switch (unwrappedDir.dir.dir.tag) {
				case DirWithMetaEnum_Tags.Dir: {
					cache.directoryUuidToAnyDirWithShareInfo.set(unwrappedDir.uuid, new AnyDirEnumWithShareInfo.SharedDir(unwrappedDir.dir))

					break
				}

				case DirWithMetaEnum_Tags.Root: {
					cache.directoryUuidToAnyDirWithShareInfo.set(
						unwrappedDir.uuid,
						new AnyDirEnumWithShareInfo.Root(unwrappedDir.dir.dir.inner[0])
					)

					break
				}
			}
		}
	}

	for (const resultFile of result.files) {
		const unwrappedFile = unwrapFileMeta(resultFile)
		const item = unwrappedFileIntoDriveItem(unwrappedFile)

		items.push(item)

		if (!unwrappedFile.shared) {
			cache.uuidToDriveItem.set(unwrappedFile.file.uuid, item)
		} else {
			cache.uuidToDriveItem.set(unwrappedFile.file.file.uuid, item)
		}
	}

	return items
}

export function useDriveItemsQuery(
	params: UseDriveItemsQueryParams,
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const defaultParams = useDefaultQueryParams(options)
	const sortedParams = sortParams(params)

	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		...defaultParams,
		...options,
		queryKey: [BASE_QUERY_KEY, sortedParams],
		queryFn: ({ signal }) =>
			fetchData({
				...sortedParams,
				signal
			})
	})

	useRefreshOnFocus({
		isEnabled: query.isEnabled,
		refetch: query.refetch
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
	const sortedParams = sortParams(params)

	queryUpdater.set<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY, sortedParams], prev => {
		const currentData = prev ?? ([] satisfies Awaited<ReturnType<typeof fetchData>>)

		return typeof updater === "function" ? updater(currentData) : updater
	})
}

const DRIVE_PATH_TYPES_EXTENDED: (string | null)[] = [...DRIVE_PATH_TYPES, null]

export function driveItemsQueryUpdateGlobal({
	updater,
	parentUuid
}: {
	updater:
		| Awaited<ReturnType<typeof fetchData>>
		| ((prev: Awaited<ReturnType<typeof fetchData>>) => Awaited<ReturnType<typeof fetchData>>)
	parentUuid: string
}): void {
	for (const pathType of DRIVE_PATH_TYPES_EXTENDED) {
		driveItemsQueryUpdate({
			params: {
				path: {
					type: pathType,
					uuid: parentUuid
				} as DrivePath
			},
			updater
		})

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
}

export function driveItemsQueryGet(params: UseDriveItemsQueryParams) {
	const sortedParams = sortParams(params)

	return queryUpdater.get<Awaited<ReturnType<typeof fetchData>>>([BASE_QUERY_KEY, sortedParams])
}

export default useDriveItemsQuery
