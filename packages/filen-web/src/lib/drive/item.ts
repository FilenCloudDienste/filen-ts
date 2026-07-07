import type { Dir, File, DecryptedDirMeta, DecryptedFileMeta } from "@filen/sdk-rs"

// Extra fields every DriveItem carries beyond its raw wasm shape (mirrors filen-mobile's
// ExtraData): `size` is synthetic for directories (Dir has no native size field — sort.ts's bigint
// size compare needs one so dirs group uniformly against files), `uuid` restates the item's own
// uuid at the union's shared shape, and `undecryptable` mirrors `decryptedMeta`'s nullness so a
// consumer can branch on a plain boolean instead of a null check.
export interface ExtraData {
	size: bigint
	uuid: string
	undecryptable: boolean
}

// True two-arm discriminated union: narrowing on `type` narrows `data` under max-strict (a "file"
// arm's `decryptedMeta` is `DecryptedFileMeta | null` — e.g. exposes `.mime` — a "directory" arm's
// is `DecryptedDirMeta | null` and has no `.mime`). Directory|file only — the shared-in/out/link
// variants (different item shapes entirely) are a later surface, not this union's concern.
export type DriveItem =
	| { type: "directory"; data: Dir & ExtraData & { decryptedMeta: DecryptedDirMeta | null } }
	| { type: "file"; data: File & ExtraData & { decryptedMeta: DecryptedFileMeta | null } }

// Dir/File share no discriminant field — NormalDirsAndFiles pre-splits a listing into separate
// `dirs`/`files` arrays rather than tagging each element (unlike NonRootNormalItemTagged elsewhere
// on the wasm surface) — so narrowItem structurally probes for a File-only field. `chunks` is
// absent from every Dir by the wasm shape itself, never merely optional, so this is exact rather
// than a heuristic.
function isFile(raw: Dir | File): raw is File {
	return "chunks" in raw
}

// Pure narrowing, no crypto: the SDK already decrypted `meta` before it crossed the worker
// boundary; `meta.type === "decoded"` reports that outcome, this function only reshapes it into
// the union's shared `decryptedMeta`/`undecryptable` fields. Every bigint field (`timestamp`, file
// `size`/`chunks`, meta `created`/`modified`/`size`) passes through the spread untouched.
export function narrowItem(raw: Dir | File): DriveItem {
	if (isFile(raw)) {
		const meta = raw.meta
		const decryptedMeta = meta.type === "decoded" ? meta.data : null
		return { type: "file", data: { ...raw, undecryptable: decryptedMeta === null, decryptedMeta } }
	}
	const meta = raw.meta
	const decryptedMeta = meta.type === "decoded" ? meta.data : null
	return { type: "directory", data: { ...raw, size: 0n, undecryptable: decryptedMeta === null, decryptedMeta } }
}
