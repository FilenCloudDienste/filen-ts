import { useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query"
import { outermostRoots, validateRootCandidate, type RootValidation } from "@filen/shared"
import type { SocketEvent } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { registerSocketHandler } from "@/lib/sdk/socket"
import { DOT_FILEN_DIR_NAME } from "@/lib/dotFilen"
import { queryClient } from "@/queries/client"

// The directories a feature reads recursively as its roots (the Videos libraries, the Photos timeline): their
// chains from the drive root, the check a new root goes through, and which roots overlap.

export const DIRECTORY_ROOT_CHAIN_KEY_PREFIX = ["drive", "rootChain"] as const

export type DirectoryRootChain = { uuid: string; name: string }[] | null

// Chains resolved this session. One restored from disk serves at once (offline too) and is resolved again once,
// as the drive may have changed while the app was closed; after that the socket keeps it current.
const resolvedThisSession = new Set<string>()

// A directory's chain from the drive root down to itself (names for a path, uuids to open it in the drive); null
// when it can't be resolved. Ancestors usually come from the worker's directory cache; any it lacks cost a request,
// so a chain is kept (on disk too: a few names) until a directory event touches it (forgetDirectoryRootChains).
export function directoryRootChainQueryOptions(uuid: string) {
	return {
		queryKey: [...DIRECTORY_ROOT_CHAIN_KEY_PREFIX, uuid] as const,
		queryFn: async () => {
			const chain = await runOp<DirectoryRootChain>(sdkApi.videoRootChain(uuid))

			resolvedThisSession.add(uuid)

			return chain
		},
		staleTime: () => (resolvedThisSession.has(uuid) ? Infinity : 0)
	}
}

export function useDirectoryRootChainQuery(uuid: string, enabled: boolean): UseQueryResult<DirectoryRootChain> {
	return useQuery({
		...directoryRootChainQueryOptions(uuid),
		enabled
	})
}

// The chains of several directories, in their order: undefined while one is unresolved (or waits for the network).
export function useDirectoryRootChains(uuids: readonly string[], enabled: boolean): (DirectoryRootChain | undefined)[] {
	return useQueries({
		queries: uuids.map(uuid => ({
			...directoryRootChainQueryOptions(uuid),
			enabled
		})),
		combine: chainsOf
	})
}

// Module-level, so the combined array is only rebuilt when a chain changes.
function chainsOf(results: UseQueryResult<DirectoryRootChain>[]): (DirectoryRootChain | undefined)[] {
	return results.map(result => (result.status === "error" ? null : result.data))
}

function rootChain(uuid: string): Promise<DirectoryRootChain> {
	return queryClient.query(directoryRootChainQueryOptions(uuid))
}

// A chain as a path below the drive root ("/Pictures/2024", "/" for the drive root itself); undefined while unresolved
// or unresolvable.
export function directoryChainPath(chain: DirectoryRootChain | undefined): string | undefined {
	if (chain === undefined || chain === null) {
		return undefined
	}

	return `/${chain
		.slice(1)
		.map(link => link.name)
		.join("/")}`
}

// A directory's ancestor uuids from its chain (drive root first); null when unknown.
export function chainAncestors(chain: DirectoryRootChain | undefined): string[] | null {
	return chain === undefined || chain === null ? null : chain.slice(0, -1).map(link => link.uuid)
}

// `roots` without those another of them holds, by their chains (undefined: unresolved). With one root there is
// nothing to compare.
export function outermostOfRoots(roots: readonly string[], chains: readonly (DirectoryRootChain | undefined)[]): readonly string[] {
	if (roots.length < 2) {
		return roots
	}

	return outermostRoots(roots.map((uuid, index) => ({ uuid, ancestors: chainAncestors(chains[index]) })))
}

// As outermostOfRoots, resolving the chains first (from the query cache when held).
export async function resolveOutermostRoots(roots: readonly string[]): Promise<readonly string[]> {
	if (roots.length < 2) {
		return roots
	}

	return outermostOfRoots(roots, await Promise.all(roots.map(uuid => rootChain(uuid).catch(() => null))))
}

// Whether `uuid` can become a root next to `roots`: an own-drive directory outside `.filen` that neither holds nor
// sits inside another root (the overlapped ones are offered for replacement). `ownDrive` is false for a shared-in or
// public-link directory.
export async function checkDirectoryRoot({
	uuid,
	ownDrive,
	roots
}: {
	uuid: string
	ownDrive: boolean
	roots: readonly string[]
}): Promise<RootValidation | { ok: false; reason: "notFound" }> {
	if (!ownDrive) {
		return {
			ok: false,
			reason: "notOwnDrive"
		}
	}

	const chain = await rootChain(uuid)

	if (chain === null) {
		return {
			ok: false,
			reason: "notFound"
		}
	}

	const known = await Promise.all(
		roots.map(async root => {
			const ancestors = chainAncestors(await rootChain(root))

			return ancestors === null ? null : { uuid: root, ancestors }
		})
	)
	// `.filen` sits directly under the drive root.
	const topLevel = chain[1]

	return validateRootCandidate({
		candidate: {
			uuid,
			ancestors: chain.slice(0, -1).map(entry => entry.uuid),
			ownDrive
		},
		roots: known.filter(root => root !== null),
		dotFilenUuid: topLevel?.name.toLowerCase() === DOT_FILEN_DIR_NAME ? topLevel.uuid : null
	})
}

function forgetChainsThrough(dirUuid: string): void {
	void queryClient.invalidateQueries({
		queryKey: DIRECTORY_ROOT_CHAIN_KEY_PREFIX,
		predicate: query => {
			const chain = query.state.data as DirectoryRootChain | undefined

			return query.queryKey[2] === dirUuid || (chain?.some(link => link.uuid === dirUuid) ?? false)
		}
	})
}

type DriveSocketEvent = Extract<SocketEvent, { type: "drive" }>

// A directory moved, was renamed, trashed, restored or deleted: every kept chain through it is read again.
export function forgetDirectoryRootChains(event: DriveSocketEvent): void {
	const inner = event.inner

	switch (inner.type) {
		case "folderMove":
		case "folderRestore":
			forgetChainsThrough(inner.dir.uuid)
			break
		case "folderTrash":
		case "folderDeletedPermanent":
		case "folderMetadataChanged":
			forgetChainsThrough(inner.uuid)
			break
		default:
			break
	}
}

// Called once by the authed shell's socket host.
export function registerDirectoryRootSocketHandlers(): () => void {
	return registerSocketHandler("drive", forgetDirectoryRootChains)
}
