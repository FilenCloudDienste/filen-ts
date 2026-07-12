import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import type { LinkedFile, DirPublicInfo, LinkedDirsAndFiles, AnyLinkedDir, DirPublicLink, DirSizeResponse } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"

// ★ SECURITY: the decryption key AND any visitor-typed password MUST NOT appear in a react-query key.
// The default key hasher JSON-stringifies the whole key into `queryHash`, which the global queryCache
// `onError` LOGS (queries/client.ts) and the persister uses as its on-disk row name — either would
// leak the secret. So every secret travels ONLY through the queryFn closure below; the query key
// instead carries a NON-SECRET djb2 fingerprint of it, purely so the query re-runs when the fragment
// key or password changes.
//
// djb2 → base36. One-way-ish (a 32-bit digest of a ~32-char secret is not reversible to it) and,
// unlike the secret, safe to log/persist. A collision only risks serving one wrong secret's cached
// error for another of the same uuid — a manual reload corrects it, never a data-exposure path.
function secretFingerprint(...parts: (string | undefined)[]): string {
	let h = 5381

	for (const part of parts) {
		const value = part ?? ""

		// A per-part separator so ("ab","c") and ("a","bc") never digest identically.
		h = (Math.imul(h, 33) + 0x1f) | 0

		for (let i = 0; i < value.length; i++) {
			h = (Math.imul(h, 33) + value.charCodeAt(i)) | 0
		}
	}

	return (h >>> 0).toString(36)
}

export function publicLinkQueryKey(scope: string, uuid: string, secret: string) {
	return ["publicLinks", scope, { uuid, k: secret }] as const
}

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
