import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS } from "@/queries/client"
import auth from "@/lib/auth"
import { sortParams } from "@filen/utils"
import cache from "@/lib/cache"
import {
	AnyDirWithContext_Tags,
	AnyDirWithContext,
	AnyNormalDir,
	AnyNormalDir_Tags,
	ParentUuid,
	AnyLinkedDirWithContext,
	AnySharedDir,
	AnySharedDirWithContext
} from "@filen/sdk-rs"
import offline from "@/features/offline/offline"
import { isDirectoryItem } from "@/features/drive/driveSelectors"
import { type DriveItem } from "@/types"

export const BASE_QUERY_KEY = "useDirectorySizeQuery"

/**
 * Thrown when the directory whose size is requested can't be resolved — neither the
 * by-value item nor the (session-scoped) uuid cache yields a context to size. Surfacing
 * this (instead of resolving to a silent `{ size: 0 }`) lands the query in `isError`, so
 * TanStack keeps any prior/restored size rendering (stale-while-error) rather than a wrong
 * zero that would also overwrite the persisted real size with a fresh timestamp.
 */
export class DirectorySizeUnresolvedError extends Error {
	public constructor(uuid: string) {
		super(`Directory size unresolved: ${uuid}`)

		this.name = "DirectorySizeUnresolvedError"
	}
}

export type UseDirectorySizeQueryParams = {
	uuid: string
	type: "offline" | "trash" | "sharedIn" | "sharedOut" | "normal" | "linked"
	// Optional by-value item, preferred over the cache lookup so a screen that already holds a valid
	// item resolves even when the session-scoped uuid cache never observed this directory. NEVER part
	// of the query key (see directorySizeQueryKey) so one uuid+type shares a single cache entry
	// regardless of resolution source.
	item?: DriveItem
}

export async function fetchData(
	params: UseDirectorySizeQueryParams & {
		signal?: AbortSignal
	}
): Promise<{
	size: number
	files: number
	dirs: number
}> {
	// Offline sizes resolve fully from the local index — short-circuit before the SDK-context
	// wrapper machinery, which the offline store carries no AnyDirWithContext for. Prefer the
	// by-value item; a missing / non-directory item is unresolvable (throw, never a wrong zero).
	if (params.type === "offline") {
		const item = params.item ?? cache.uuidToAnyDriveItem.get(params.uuid)

		if (item && isDirectoryItem(item)) {
			return await offline.itemSize(item)
		}

		throw new DirectorySizeUnresolvedError(params.uuid)
	}

	let anyDirWithContext = (() => {
		switch (params.type) {
			case "normal":
			case "trash": {
				// Prefer the by-value item — a directory the caller holds resolves even when the
				// session-scoped normal-dir cache never observed it.
				if (params.item && params.item.type === "directory") {
					return new AnyDirWithContext.Normal(new AnyNormalDir.Dir(params.item.data))
				}

				const fromCache = cache.directoryUuidToAnyNormalDir.get(params.uuid)

				if (fromCache) {
					return new AnyDirWithContext.Normal(fromCache)
				}

				return null
			}

			case "sharedIn":
			case "sharedOut": {
				// The listing stamps the share role onto every child, so a by-value shared item
				// carries the context needed to build the wrapper. A shared subdirectory whose role
				// didn't survive onto the item falls through to the cache.
				if (params.item) {
					if (params.item.type === "sharedRootDirectory") {
						return new AnyDirWithContext.Shared(
							AnySharedDirWithContext.new({
								dir: new AnySharedDir.Root(params.item.data),
								shareInfo: params.item.data.sharingRole
							})
						)
					}

					if (params.item.type === "sharedDirectory" && params.item.data.sharingRole) {
						return new AnyDirWithContext.Shared(
							AnySharedDirWithContext.new({
								dir: new AnySharedDir.Dir(params.item.data),
								shareInfo: params.item.data.sharingRole
							})
						)
					}
				}

				const fromCache = cache.directoryUuidToAnySharedDirWithContext.get(params.uuid)

				if (fromCache) {
					return new AnyDirWithContext.Shared(fromCache)
				}

				return null
			}

			case "linked": {
				// No by-value derivation: the parent link's meta isn't carried on the item.
				const fromCache = cache.directoryUuidToAnyLinkedDirWithMeta.get(params.uuid)

				if (fromCache) {
					return new AnyDirWithContext.Linked(
						AnyLinkedDirWithContext.new({
							dir: fromCache.dir,
							link: fromCache.meta
						})
					)
				}

				return null
			}
		}
	})()

	// An unresolved context must land the query in isError (prior/restored sizes keep rendering)
	// rather than resolve to a wrong zero that would overwrite a persisted real size.
	if (!anyDirWithContext) {
		throw new DirectorySizeUnresolvedError(params.uuid)
	}

	// Hack so we can get the size of items in the trash, pretty ugly but it works for now
	if (
		params.type === "trash" &&
		anyDirWithContext.tag === AnyDirWithContext_Tags.Normal &&
		anyDirWithContext.inner[0].tag === AnyNormalDir_Tags.Dir
	) {
		anyDirWithContext = new AnyDirWithContext.Normal(
			new AnyNormalDir.Dir({
				...anyDirWithContext.inner[0].inner[0],
				// SDK 0.4.35: ParentUuid.Trash carries the item's original parent; the nil
				// uuid is the documented placeholder for a transient list-trash request
				// target (every string/wire encoding renders it as "trash" regardless).
				parent: new ParentUuid.Trash("00000000-0000-0000-0000-000000000000")
			})
		)
	}

	const { authedSdkClient } = await auth.getSdkClients()
	const { size, files, dirs } = await authedSdkClient.getDirSize(
		anyDirWithContext,
		params?.signal
			? {
					signal: params.signal
				}
			: undefined
	)

	return {
		size: Number(size),
		files: Number(files),
		dirs: Number(dirs)
	}
}

// Stable query key: identity (uuid + type) only, with the optional by-value item stripped so its
// object identity can't destabilize the key and both resolution sources for one uuid+type share a
// single cache entry. Fed through sortParams by every key builder below.
export function directorySizeQueryKey(params: UseDirectorySizeQueryParams): {
	uuid: string
	type: UseDirectorySizeQueryParams["type"]
} {
	return {
		uuid: params.uuid,
		type: params.type
	}
}

// Key + fn + freshness in one place so useQuery (rows) and prefetchQuery (size sort) can never
// drift apart — a prefetch with a mismatched key would fetch twice and read nothing back. The item
// rides along into fetchData but is stripped from the key by directorySizeQueryKey.
export function directorySizeQueryOptions(params: UseDirectorySizeQueryParams): {
	queryKey: [string, ReturnType<typeof directorySizeQueryKey>]
	queryFn: (context: { signal?: AbortSignal }) => ReturnType<typeof fetchData>
	staleTime: number
} {
	return {
		// TODO: Change with API v4
		staleTime: 15 * 60 * 1000, // 15 minutes
		queryKey: [BASE_QUERY_KEY, sortParams(directorySizeQueryKey(params))],
		queryFn: ({ signal }) =>
			fetchData({
				...params,
				signal
			})
	}
}

export function useDirectorySizeQuery(
	params: UseDirectorySizeQueryParams,
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		...options,
		...directorySizeQueryOptions(params)
	})

	return query as UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error>
}

export default useDirectorySizeQuery
