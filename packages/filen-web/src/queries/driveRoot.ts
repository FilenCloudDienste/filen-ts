import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
import { accountQueryGet } from "@/queries/account"

// The drive root's uuid, read from the worker's live client (its session holds it: no request). The account's
// rootDirUuid names the same directory, but only once getUserInfo has answered over the network, while a listing
// restored from disk or fetched first can already be on screen. One per session: the cache is cleared on sign-out.
export const DRIVE_ROOT_UUID_QUERY_KEY = ["driveRootUuid"] as const

async function fetchDriveRootUuid(): Promise<string> {
	const uuid = await sdkApi.driveRootUuid()

	// Never cached as an answer: a read before the session is in would otherwise stick for the whole session.
	if (uuid === null) {
		throw new Error("no authenticated client")
	}

	return uuid
}

const driveRootUuidQueryOptions = {
	queryKey: DRIVE_ROOT_UUID_QUERY_KEY,
	queryFn: fetchDriveRootUuid,
	staleTime: Infinity
} as const

// Called once the session is in (boot.ts), so a first render already has it. Never rejects: a miss only means the
// first observer reads it instead.
export async function warmDriveRootUuid(): Promise<void> {
	await queryClient.query(driveRootUuidQueryOptions).catch(() => undefined)
}

export function useDriveRootUuidQuery(): UseQueryResult<string> {
	return useQuery(driveRootUuidQueryOptions)
}

// For code outside React: the session's root, else the account's (the same directory).
export function driveRootUuidGet(): string | undefined {
	return queryClient.getQueryData<string>(DRIVE_ROOT_UUID_QUERY_KEY) ?? accountQueryGet()?.rootDirUuid
}
