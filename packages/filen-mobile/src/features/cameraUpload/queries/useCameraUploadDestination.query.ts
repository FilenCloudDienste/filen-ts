import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS } from "@/queries/client"
import { type AnyNormalDir, AnyNormalDir_Tags } from "@filen/sdk-rs"
import auth from "@/lib/auth"
import { unwrapDirMeta, isTrashParent } from "@/lib/sdkUnwrap"

export const BASE_QUERY_KEY = "useCameraUploadDestinationQuery"

export type UseCameraUploadDestinationQueryParams = {
	uuid: string
}

export type CameraUploadDestination = {
	usable: boolean
	name: string | null
}

export async function fetchData(
	params: UseCameraUploadDestinationQueryParams & {
		signal?: AbortSignal
	}
): Promise<CameraUploadDestination> {
	const { authedSdkClient } = await auth.getSdkClients()
	const dir = await authedSdkClient.getDirOptional(params.uuid, params.signal ? { signal: params.signal } : undefined)

	// undefined (permanently deleted) or a Trash-parented Dir ⇒ unusable. unwrapDirMeta accepts a
	// plain Dir struct directly (its "uuid" in dir branch), so the fresh decrypted name comes from
	// the same listing without re-fetching; null when deleted or undecryptable.
	return {
		usable: dir !== undefined && !isTrashParent(dir.parent),
		name: dir ? (unwrapDirMeta(dir).meta?.name ?? null) : null
	}
}

export function useCameraUploadDestinationQuery(
	params: UseCameraUploadDestinationQueryParams,
	options?: Omit<UseQueryOptions<Awaited<ReturnType<typeof fetchData>>, Error>, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const query = useQuery<Awaited<ReturnType<typeof fetchData>>, Error>({
		...DEFAULT_QUERY_OPTIONS,
		...options,
		queryKey: [BASE_QUERY_KEY, params],
		queryFn: ({ signal }) =>
			fetchData({
				...params,
				signal
			})
	})

	return query
}

// Convenience hook resolving a config's destination directory to a render-ready shape. Handles the
// three non-fetching cases inline (no destination configured ⇒ configured:false; the account root
// ⇒ always usable, no request) and only hits the network for a real directory uuid. The underlying
// query is ALWAYS called (hooks rule) and gated via `enabled` so the non-fetching cases never run a
// request.
export function useCameraUploadDestination(remoteDir: AnyNormalDir | null): {
	configured: boolean
	loading: boolean
	usable: boolean
	name: string | null
} {
	const isRoot = remoteDir !== null && remoteDir.tag === AnyNormalDir_Tags.Root
	const uuid = remoteDir !== null && !isRoot ? remoteDir.inner[0].uuid : null

	const query = useCameraUploadDestinationQuery(
		{
			uuid: uuid ?? ""
		},
		{
			enabled: uuid !== null
		}
	)

	if (remoteDir === null) {
		return {
			configured: false,
			loading: false,
			usable: false,
			name: null
		}
	}

	if (isRoot) {
		return {
			configured: true,
			loading: false,
			usable: true,
			name: null
		}
	}

	return {
		configured: true,
		loading: query.status === "pending",
		usable: query.data?.usable ?? false,
		name: query.data?.name ?? null
	}
}

export default useCameraUploadDestinationQuery
