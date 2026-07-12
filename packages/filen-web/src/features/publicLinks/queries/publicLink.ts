import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import type { LinkedFile, DirPublicInfo, LinkedDirsAndFiles, AnyLinkedDir, DirPublicLink, DirSizeResponse } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { publicLinkQueryKey, secretFingerprint } from "@/features/publicLinks/lib/queryKey.logic"

// ★ SECURITY: the decryption key AND any visitor-typed password MUST NOT appear in a react-query key —
// every secret travels ONLY through the queryFn closures below; the key carries a non-secret djb2
// fingerprint of it (queryKey.logic.ts) so a query re-runs when the fragment key or password changes.

// `MaybeEncrypted<string>` narrow (mirrors chatMessageLinks.ts's decryptedName) — a still-encrypted
// name degrades to the uuid rather than throwing, so an undecryptable-but-resolvable link still
// renders a stable label instead of an error.
export function decryptedLinkName(name: { Decrypted: string } | { Encrypted: unknown }, fallback: string): string {
	return "Decrypted" in name ? name.Decrypted : fallback
}

// FILE link resolution against the UNAUTHENTICATED worker surface. `password` is undefined until the
// visitor supplies one; a protected file throws until it matches (mapped to the password gate by the
// caller's fileAccessState). `uuid`/`key` null (unresolvable fragment) keeps the query disabled. The
// passthrough persister runs the queryFn with NO storage round trip — a public resolution must leave
// nothing on this browser's disk (an explicit `undefined` is rejected under exactOptionalPropertyTypes,
// so it overrides the client's default persister this way).
export function usePublicFile(uuid: string | null, key: string | null, password: string | undefined): UseQueryResult<LinkedFile> {
	const enabled = uuid !== null && key !== null

	return useQuery({
		queryKey: publicLinkQueryKey("file", uuid ?? "disabled", secretFingerprint(key ?? undefined, password)),
		queryFn: () => sdkApi.getLinkedFileAnon(uuid ?? "", key ?? "", password),
		enabled,
		retry: false,
		persister: (queryFn, context) => queryFn(context)
	})
}

// DIRECTORY link info — root handle, link handle, and the up-front hasPassword flag. Resolves WITHOUT
// a password (the password is validated separately by listing the root with it set).
export function usePublicDirInfo(uuid: string | null, key: string | null): UseQueryResult<DirPublicInfo> {
	const enabled = uuid !== null && key !== null

	return useQuery({
		queryKey: publicLinkQueryKey("dirInfo", uuid ?? "disabled", secretFingerprint(key ?? undefined)),
		queryFn: () => sdkApi.getDirPublicLinkInfoAnon(uuid ?? "", key ?? ""),
		enabled,
		retry: false,
		persister: (queryFn, context) => queryFn(context)
	})
}

// Aggregate size + item counts for one level's header. Best-effort (the header renders without it
// until it lands), so a failure is silent — it never blocks the listing.
export function usePublicDirSize(args: {
	levelUuid: string | null
	dir: AnyLinkedDir | null
	link: DirPublicLink | null
}): UseQueryResult<DirSizeResponse> {
	const { levelUuid, dir, link } = args
	const enabled = levelUuid !== null && dir !== null && link !== null

	return useQuery({
		queryKey: publicLinkQueryKey("size", levelUuid ?? "disabled", secretFingerprint(link?.linkKey, link?.password)),
		queryFn: () => {
			if (dir === null || link === null) {
				throw new Error("public-link size invoked without a resolved directory")
			}

			return sdkApi.getLinkedDirSizeAnon({ dir, link })
		},
		enabled,
		retry: false,
		persister: (queryFn, context) => queryFn(context)
	})
}

// One directory LEVEL's listing. Keyed by that level's own uuid plus a fingerprint of the link key +
// password, so entering a subfolder is a fresh cache entry and a password change re-runs every level.
// The `dir`/`link` handles ride the closure only — never the key.
export function usePublicDirListing(args: {
	levelUuid: string | null
	dir: AnyLinkedDir | null
	link: DirPublicLink | null
}): UseQueryResult<LinkedDirsAndFiles> {
	const { levelUuid, dir, link } = args
	const enabled = levelUuid !== null && dir !== null && link !== null

	return useQuery({
		queryKey: publicLinkQueryKey("listing", levelUuid ?? "disabled", secretFingerprint(link?.linkKey, link?.password)),
		queryFn: () => {
			if (dir === null || link === null) {
				throw new Error("public-link listing invoked without a resolved directory")
			}

			return sdkApi.listLinkedDirAnon(dir, link)
		},
		enabled,
		retry: false,
		persister: (queryFn, context) => queryFn(context)
	})
}
