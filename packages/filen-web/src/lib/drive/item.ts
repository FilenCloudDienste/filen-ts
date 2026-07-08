import type {
	Dir,
	File,
	DecryptedDirMeta,
	DecryptedFileMeta,
	SharedDir,
	SharedRootDir,
	SharedFile,
	SharingRole,
	ShareInfo,
	AnyDirWithContext
} from "@filen/sdk-rs"

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

// The four shared arms carry a Dir|File-shaped `data` (the underlying item flattened out of its
// SharedDir/SharedRootDir/SharedFile wrapper) PLUS the sharing metadata — so a consumer that only
// cares about the base item can treat a shared-directory like a directory and a shared-file like a
// file with no per-arm branching (see asDirectoryOrFile). `sharingRole` is the OTHER party's role
// (see getSharerIdentity): required on every arm that natively carries one, optional on the nested
// sharedDirectory (a SharedDir has no own role — the fetcher spreads the parent's onto it, and a
// path that rebuilds one without the spread relies on the resolver fallback instead).
//
// Three of the four shared arms additionally retain the untouched wasm value they were flattened
// from, as `shareSource` — each for its own consumer. The two ROOT arms (sharedRootDirectory/
// sharedRootFile) retain theirs for the worker's removeSharedItem(item: SharedRootItem), which
// forwards it straight to the SDK — SharedRootItem deserializes as an UNTAGGED union (SharedRootDir |
// SharedFile), and a flattened directory's `data` has no `inner` wrapper, matching NEITHER variant.
// The nested sharedDirectory arm retains its own for a different consumer: @filen/sdk-rs's
// AnyDirWithContext is ALSO an untagged union (AnySharedDirWithContext | AnyLinkedDirWithContext |
// AnyNormalDir) — a flattened shared directory's bare Dir-shaped data matches AnyNormalDir instead of
// the dedicated Shared arm, silently routing a category-dispatched op (zip download, getDirSize) down
// the OWNED code path. toAnyDirWithContext below rebuilds the real wrapper from this retained value.
// The nested sharedFile arm alone gets none: it's narrowed from a plain File the fetcher spread a role
// onto — no real wasm SharedFile ever backed it (only a ROOT file's data was ever a genuine SharedFile)
// — there is nothing to retain, and file content downloads need no category dispatch to begin with.
type SharedDirectoryData = Dir &
	ExtraData & { decryptedMeta: DecryptedDirMeta | null; sharedTag: boolean; sharingRole?: SharingRole; shareSource: SharedDir }
type SharedRootDirectoryData = Dir &
	ExtraData & { decryptedMeta: DecryptedDirMeta | null; sharingRole: SharingRole; writeAccess: boolean; shareSource: SharedRootDir }
type SharedFileData = File & ExtraData & { decryptedMeta: DecryptedFileMeta | null; sharedTag: boolean; sharingRole: SharingRole }
// sharedRootFile-only split: the nested sharedFile arm below is narrowed from a plain File the fetcher
// spread a role onto — no real wasm SharedFile ever backed it — so it stays on SharedFileData with no
// shareSource. Only a ROOT file's data was ever constructed from a genuine SharedFile.
type SharedRootFileData = SharedFileData & { shareSource: SharedFile }

// Six-arm discriminated union: narrowing on `type` narrows `data` under max-strict (a file arm's
// `decryptedMeta` is `DecryptedFileMeta | null` — exposes `.mime` — a directory arm's is
// `DecryptedDirMeta | null` and has none). The two base arms stay EXACTLY as the wasm shape; the
// four shared arms add a normalized Dir|File base plus their sharing metadata, so a shared item is
// structurally directory-like / file-like where it matters (icon, sort, navigation) while still
// carrying the sharing context real per-arm handling reads later.
export type DriveItem =
	| { type: "directory"; data: Dir & ExtraData & { decryptedMeta: DecryptedDirMeta | null } }
	| { type: "file"; data: File & ExtraData & { decryptedMeta: DecryptedFileMeta | null } }
	| { type: "sharedDirectory"; data: SharedDirectoryData }
	| { type: "sharedRootDirectory"; data: SharedRootDirectoryData }
	| { type: "sharedFile"; data: SharedFileData }
	| { type: "sharedRootFile"; data: SharedRootFileData }

// The base directory|file projection asDirectoryOrFile maps every arm onto — its `data` is a
// structural superset of Dir/File, so it is assignable to the plain wasm shapes the worker's
// held-item ops declare (rename/move/trash/…), which only ever run against base items.
export interface BaseDirectoryItem {
	type: "directory"
	data: Dir & ExtraData & { decryptedMeta: DecryptedDirMeta | null }
}
export interface BaseFileItem {
	type: "file"
	data: File & ExtraData & { decryptedMeta: DecryptedFileMeta | null }
}

// What narrowItem accepts: the two base wasm shapes, the two shared-root shapes, and the two nested
// shapes AFTER the fetcher has spread the parent `sharingRole` onto them (a nested SharedDir/File
// is otherwise structurally a plain dir/file — the spread is what lets the structural narrow below
// classify it). `File`/`SharedDir` widened with an optional `sharingRole` so a plain (un-spread)
// base item is still assignable.
type NarrowableFileInput = (File & { sharingRole?: SharingRole }) | SharedFile
type NarrowableDirInput = Dir | SharedRootDir | (SharedDir & { sharingRole?: SharingRole })
export type NarrowItemInput = NarrowableFileInput | NarrowableDirInput

// Dir/File and their shared shapes share no discriminant field of their own — a listing pre-splits
// into `dirs`/`files` arrays rather than tagging each element — so this structurally probes for the
// File-family `chunks` field, absent from every dir shape by the wasm layout itself (never merely
// optional). SharedFile carries `chunks` too, so this splits file-family from dir-family across all
// six inputs before the per-family discriminators below refine the arm.
export function narrowItem(raw: NarrowItemInput): DriveItem {
	if ("chunks" in raw) {
		return narrowFile(raw)
	}
	return narrowDir(raw)
}

// File-family discriminators (mirror filen-mobile's sdkUnwrap): a SharedFile is the only file shape
// with no `favorited` field → sharedRootFile; a base File the fetcher spread a `sharingRole` onto is
// a nested shared file → sharedFile; anything else is a plain file. The SDK already decrypted `meta`
// before it crossed the worker boundary; `meta.type === "decoded"` reports that outcome, and every
// bigint field passes through untouched.
function narrowFile(raw: NarrowableFileInput): DriveItem {
	if (!("favorited" in raw)) {
		const decryptedMeta = raw.meta.type === "decoded" ? raw.meta.data : null
		// SharedFile lacks a normal item's `parent`/`favorited`/`canMakeThumbnail`; a shared-root file
		// has no navigable normal parent and is never favorited/thumbnailed through this arm, so those
		// are synthesized inert (self-uuid parent, false flags) purely to keep the base File shape whole.
		// `shareSource` retains the untouched raw SharedFile (see the union's own doc comment above) —
		// removeSharedItem needs the genuine wasm value, never this synthesized shape.
		return {
			type: "sharedRootFile",
			data: {
				uuid: raw.uuid,
				meta: raw.meta,
				parent: raw.uuid,
				size: raw.size,
				favorited: false,
				region: raw.region,
				bucket: raw.bucket,
				timestamp: raw.timestamp,
				chunks: raw.chunks,
				canMakeThumbnail: false,
				undecryptable: decryptedMeta === null,
				decryptedMeta,
				sharedTag: raw.sharedTag,
				sharingRole: raw.sharingRole,
				shareSource: raw
			}
		}
	}

	const decryptedMeta = raw.meta.type === "decoded" ? raw.meta.data : null
	const role = raw.sharingRole

	if (role !== undefined) {
		return {
			type: "sharedFile",
			data: { ...raw, undecryptable: decryptedMeta === null, decryptedMeta, sharedTag: true, sharingRole: role }
		}
	}

	return { type: "file", data: { ...raw, undecryptable: decryptedMeta === null, decryptedMeta } }
}

// Dir-family discriminators (mirror filen-mobile's sdkUnwrap): a plain Dir is the only dir shape
// with a top-level `uuid` → directory; a SharedDir is the only remaining shape with a `sharedTag`
// → sharedDirectory (picking up the fetcher-spread role if present); anything else is a SharedRootDir
// → sharedRootDirectory. The shared arms flatten their underlying dir out of `.inner` so `data` is a
// real Dir shape.
function narrowDir(raw: NarrowableDirInput): DriveItem {
	if ("uuid" in raw) {
		const decryptedMeta = raw.meta.type === "decoded" ? raw.meta.data : null
		return { type: "directory", data: { ...raw, size: 0n, undecryptable: decryptedMeta === null, decryptedMeta } }
	}

	if ("sharedTag" in raw) {
		const inner = raw.inner
		const decryptedMeta = inner.meta.type === "decoded" ? inner.meta.data : null
		const role = raw.sharingRole
		// `shareSource` retains the untouched raw SharedDir (see the union's own doc comment above) —
		// toAnyDirWithContext needs the genuine wasm value to rebuild AnyDirWithContext; `data` itself
		// lost `inner` in the flattening above.
		return {
			type: "sharedDirectory",
			data: {
				...inner,
				size: 0n,
				undecryptable: decryptedMeta === null,
				decryptedMeta,
				sharedTag: raw.sharedTag,
				...(role !== undefined ? { sharingRole: role } : {}),
				shareSource: raw
			}
		}
	}

	const inner = raw.inner
	const decryptedMeta = inner.meta.type === "decoded" ? inner.meta.data : null
	// RootDirWithMeta lacks a Dir's `parent`/`favorited`; a shared-root directory has no navigable
	// normal parent and is never favorited through this arm, so those are synthesized inert (self-uuid
	// parent, false) purely to keep the base Dir shape whole. `shareSource` retains the untouched raw
	// SharedRootDir (see the union's own doc comment above), `inner` wrapper and all — `data` itself
	// lost `inner` in the flattening above, so it alone can't round-trip through removeSharedItem.
	return {
		type: "sharedRootDirectory",
		data: {
			uuid: inner.uuid,
			parent: inner.uuid,
			color: inner.color,
			timestamp: inner.timestamp,
			favorited: false,
			meta: inner.meta,
			size: 0n,
			undecryptable: decryptedMeta === null,
			decryptedMeta,
			sharingRole: raw.sharingRole,
			writeAccess: raw.writeAccess,
			shareSource: raw
		}
	}
}

// Collapses any of the six arms onto the base directory|file projection: the base arms pass through
// unchanged (same reference), and each shared arm re-tags to directory|file over its already
// Dir|File-shaped `data`. The consumer fan-out routes its binary directory-vs-file dispatch through
// this so a shared directory sorts/navigates like a directory and a shared file like a file, while
// the worker's base-item ops receive Dir|File-assignable data.
export function asDirectoryOrFile(item: DriveItem): BaseDirectoryItem | BaseFileItem {
	switch (item.type) {
		case "directory":
		case "file":
			return item
		case "sharedDirectory":
		case "sharedRootDirectory":
			return { type: "directory", data: item.data }
		case "sharedFile":
		case "sharedRootFile":
			return { type: "file", data: item.data }
	}
}

// Rebuilds the SDK's AnyDirWithContext from a directory-arm DriveItem — the shape every
// category-dispatched dir op (zip download, getDirSize, …) needs so an UNTAGGED union match lands on
// the right arm. A plain owned directory needs no wrapper (data is already an AnyNormalDir). A
// sharedRootDirectory's role is required at the type level, so its wrapper always builds. A nested
// sharedDirectory's role is only ever present via the fetcher's spread (queries/drive.ts) — if it's
// missing there is no correct arm to dispatch to, so this throws rather than let the caller fall
// through to the owned arm and mis-list/mis-decrypt a share silently.
export function toAnyDirWithContext(
	item: Extract<DriveItem, { type: "directory" | "sharedDirectory" | "sharedRootDirectory" }>
): AnyDirWithContext {
	switch (item.type) {
		case "directory":
			return item.data
		case "sharedRootDirectory":
			return { dir: item.data.shareSource, shareInfo: item.data.sharingRole }
		case "sharedDirectory": {
			const { sharingRole } = item.data

			if (sharingRole === undefined) {
				throw new Error("toAnyDirWithContext: nested sharedDirectory has no sharingRole to dispatch with")
			}

			return { dir: item.data.shareSource, shareInfo: sharingRole }
		}
	}
}

// The OTHER party's identity for a block filter: a bigint user id (BigInt-normalized — ShareInfo.id
// is `number` on the wasm surface, but the block list keys on `Set<bigint>`; an un-normalized number
// never matches, silently leaking a blocked user's shared item) plus their email.
export interface ShareIdentity {
	userId: bigint
	email: string
}

// DUAL-SURFACE (see the SDK's dual .d.ts / uniffi runtime): the wasm `.d.ts` types SharingRole as
// the externally-tagged `{ Sharer: ShareInfo } | { Receiver: ShareInfo }`, but a uniffi-style runtime
// can instead surface a `{ tag, inner: [ShareInfo] }` shape. This widened view has every possible
// carrier optional so the extractor reads whichever is actually present at runtime while still
// type-checking against the declared shape.
interface RuntimeSharingRole {
	inner?: readonly ShareInfo[]
	Sharer?: ShareInfo
	Receiver?: ShareInfo
}

function shareInfoFromRole(role: SharingRole | undefined): ShareInfo | null {
	if (role === undefined) {
		return null
	}

	const runtime: RuntimeSharingRole = role
	const inner = runtime.inner

	if (inner !== undefined && inner.length > 0) {
		const first = inner[0]
		if (first !== undefined) {
			return first
		}
	}

	return runtime.Sharer ?? runtime.Receiver ?? null
}

// Resolves the OTHER party's identity for a shared item (in the sharedIn context, the sharer). The
// root and file arms carry the role directly; a nested sharedDirectory reads its spread `sharingRole`
// and falls back to `resolveNestedRole` (the block filter injects a resolver over its own shared-dir
// context — a SharedDir has no native role) when the spread is absent. A non-shared arm, or a role
// no known shape can be read from, resolves to null.
export function getSharerIdentity(item: DriveItem, resolveNestedRole?: (uuid: string) => SharingRole | undefined): ShareIdentity | null {
	let role: SharingRole | undefined

	switch (item.type) {
		case "sharedRootFile":
		case "sharedFile":
		case "sharedRootDirectory":
			role = item.data.sharingRole
			break
		case "sharedDirectory":
			role = item.data.sharingRole ?? resolveNestedRole?.(item.data.uuid)
			break
		default:
			return null
	}

	const info = shareInfoFromRole(role)

	if (info === null) {
		return null
	}

	return { userId: BigInt(info.id), email: info.email }
}

// Identity/name-collision filter for splicing an incoming item into a cached listing: an existing
// row survives unless it IS the incoming item (uuid match) or a same-name duplicate the incoming
// item supersedes (case-insensitive, trimmed) — mirrors filen-mobile's driveSelectors
// keepAgainstIncomingDriveItem. The name arm only fires when BOTH names are present: an
// undecryptable item's decryptedMeta is null (name undefined), and undefined === undefined would
// wrongly treat every undecryptable row as colliding with every other one.
export function keepAgainstIncomingDriveItem(existing: DriveItem, incoming: DriveItem): boolean {
	if (existing.data.uuid === incoming.data.uuid) {
		return false
	}

	const existingName = existing.data.decryptedMeta?.name.toLowerCase().trim()
	const incomingName = incoming.data.decryptedMeta?.name.toLowerCase().trim()

	if (existingName !== undefined && incomingName !== undefined && existingName === incomingName) {
		return false
	}

	return true
}

// Insert an incoming item into a cached listing, replacing (never duplicating) whatever row it
// collides with — see keepAgainstIncomingDriveItem. Covers createDirectory's idempotent-existing-
// directory return: the backend hands back the SAME uuid it already returned last time, so the
// stale cached row is dropped and the fresh one appended, net item count unchanged.
export function upsertDriveItem(items: DriveItem[], incoming: DriveItem): DriveItem[] {
	return [...items.filter(existing => keepAgainstIncomingDriveItem(existing, incoming)), incoming]
}
