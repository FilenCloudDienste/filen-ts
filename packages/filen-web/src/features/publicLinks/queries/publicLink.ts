import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { sdkApi } from "@/lib/sdk/client"
import { linkedFileIntoDriveItem } from "@/features/drive/lib/item"
import { previewType } from "@/features/drive/lib/preview.logic"
import type { PublicLinkKind } from "@/features/publicLinks/lib/format.logic"
import type { PublicLinkResource } from "@/features/publicLinks/lib/state.logic"

// ★ SECURITY: the decryption key MUST NOT appear in the react-query key. The default key hasher
// JSON-stringifies the whole key into `queryHash`, which the global queryCache `onError` LOGS
// (queries/client.ts) and the persister uses as its on-disk row name — either would leak the secret.
// So the key travels ONLY through the queryFn closure below; the query key instead carries a
// NON-SECRET fingerprint of it, purely so the query re-runs when the fragment's key changes.
//
// djb2 → base36. One-way-ish (a 32-bit digest of a ~32-char key is not reversible to it) and, unlike
// the key, safe to log/persist. Collision only risks serving one wrong-key link's cached error for
// another wrong key of the same uuid — a manual reload corrects it; never a data-exposure path.
function keyFingerprint(key: string): string {
	let h = 5381

	for (let i = 0; i < key.length; i++) {
		h = (Math.imul(h, 33) + key.charCodeAt(i)) | 0
	}

	return (h >>> 0).toString(36)
}

export function publicLinkQueryKey(kind: PublicLinkKind, uuid: string, key: string) {
	return ["publicLinks", "resource", { kind, uuid, k: keyFingerprint(key) }] as const
}

// `MaybeEncrypted<string>` narrow (mirrors chatMessageLinks.ts's decryptedName) — a still-encrypted
// name degrades to the uuid rather than throwing, so an undecryptable-but-resolvable link still
// renders a stable label instead of an error.
function decryptedName(name: { Decrypted: string } | { Encrypted: unknown }, fallback: string): string {
	return "Decrypted" in name ? name.Decrypted : fallback
}

// The one async leg: resolve a link's presentation metadata against the UNAUTHENTICATED worker
// surface (getLinkedFileAnon / getDirPublicLinkInfoAnon — neither touches requireClient, so a
// logged-out visitor reaches them). A directory reports password-protection up front via hasPassword;
// a protected FILE has no such flag and instead throws on resolve, mapped to the password state by
// the caller's error inspection (state.logic.ts's isPasswordError).
async function resolvePublicLink(kind: PublicLinkKind, uuid: string, key: string): Promise<PublicLinkResource> {
	if (kind === "file") {
		const file = await sdkApi.getLinkedFileAnon(uuid, key)

		return {
			kind: "file",
			name: decryptedName(file.name, uuid),
			size: file.size,
			category: previewType(linkedFileIntoDriveItem(file))
		}
	}

	const info = await sdkApi.getDirPublicLinkInfoAnon(uuid, key)

	if (info.hasPassword) {
		return { kind: "password" }
	}

	const meta = info.root.inner.meta

	return { kind: "directory", name: meta.type === "decoded" ? meta.data.name : uuid }
}

// `uuid`/`key` are null when the route couldn't resolve the fragment (bad uuid / bad-or-short key) —
// the query stays disabled and the route renders its `invalid` surface without a round trip.
export function usePublicLinkResource(kind: PublicLinkKind, uuid: string | null, key: string | null): UseQueryResult<PublicLinkResource> {
	const enabled = uuid !== null && key !== null

	return useQuery({
		queryKey: publicLinkQueryKey(kind, uuid ?? "disabled", key ?? "disabled"),
		queryFn: () => resolvePublicLink(kind, uuid ?? "", key ?? ""),
		enabled,
		// ★ Never persist a public-link resolution: it runs with an anonymous visitor's decryption key
		// (closure-only) and must leave nothing on this browser's disk. A passthrough persister runs the
		// queryFn with no storage round trip, overriding the client's default per-query persister
		// (queries/client.ts) for this query alone (an explicit `undefined` is rejected under
		// exactOptionalPropertyTypes).
		persister: (queryFn, context) => queryFn(context)
	})
}
