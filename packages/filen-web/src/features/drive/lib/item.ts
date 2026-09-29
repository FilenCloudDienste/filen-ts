import type {
	Dir,
	File,
	DecryptedDirMeta,
	DecryptedFileMeta,
	DirColor,
	SharedDir,
	SharedRootDir,
	SharedFile,
	SharingRole,
	AnyDirWithContext,
	AnyFile,
	LinkedFile
} from "@filen/sdk-rs"
import { type ExtraData, type ShareIdentity, shareIdentityFromRole } from "@filen/shared"

// The four shared arms carry a Dir|File-shaped `data` (the underlying item flattened out of its
// SharedDir/SharedRootDir/SharedFile wrapper) PLUS the sharing metadata — so a consumer that only
// cares about the base item can treat a shared-directory like a directory and a shared-file like a
// file with no per-arm branching (see asDirectoryOrFile). `sharingRole` is the OTHER party's role
// (see getSharerIdentity): required on every arm that natively carries one, optional on the nested
// sharedDirectory (a SharedDir has no own role — the fetcher spreads the parent's onto it; a path
// that rebuilds one without the spread leaves it unresolved).
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
		// SharedFile lacks a normal item's `parent`/`favorited`; a shared-root file has no navigable
		// normal parent and is never favorited through this arm, so those are synthesized inert
		// (self-uuid parent, false flag) purely to keep the base File shape whole. `canMakeThumbnail`
		// is the SDK's own per-file verdict — carried through, never synthesized, since it is the only
		// thing that decides whether the SDK will thumbnail this file. `stableUUID` is undefined by
		// contract: a shared-in file reports no whole-life id.
		// `shareSource` retains the untouched raw SharedFile (see the union's own doc comment above) —
		// removeSharedItem needs the genuine wasm value, never this synthesized shape.
		return {
			type: "sharedRootFile",
			data: {
				uuid: raw.uuid,
				stableUUID: undefined,
				meta: raw.meta,
				parent: raw.uuid,
				size: raw.size,
				favorited: false,
				region: raw.region,
				bucket: raw.bucket,
				timestamp: raw.timestamp,
				chunks: raw.chunks,
				canMakeThumbnail: raw.canMakeThumbnail,
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

// Wraps a resolved Filen file-link (a `LinkedFile` — not a tree member, no real parent directory) into
// a synthetic, self-parented DriveItem, so a chat/note file-link embed can feed the SAME preview
// machinery (previewType, PreviewOverlay, download) every owned file already uses — no second viewer
// path. Mirrors filen-mobile's lib/sdkUnwrap.ts::linkedFileIntoDriveItem
// field-for-field (decoded FileMeta built from the linked file's own name/mime/size/timestamp/key,
// self-parented, the SDK's own canMakeThumbnail carried through), but routes the fabricated wasm
// `File` through narrowItem —
// the SAME narrowing every owned file already goes through — rather than hand-building the DriveItem
// union arm a second time. The wasm SDK's AnyFile union is `LinkedFile | SharedFile | File`, so every
// downstream consumer that narrows this item back to an AnyFile (narrowToAnyFile, previewStreamUrl,
// downloadFile) already accepts the fabricated shape with zero SDK/worker/service-worker change.
// name/mime resolve to a safe fallback (the uuid / a generic octet-stream) when the link's own
// metadata arrives still-Encrypted — mirrors resolveFilenLinkData's identical decryptedName narrow.
export function linkedFileIntoDriveItem(file: LinkedFile): DriveItem {
	const name = "Decrypted" in file.name ? file.name.Decrypted : file.uuid
	const mime = "Decrypted" in file.mime ? file.mime.Decrypted : "application/octet-stream"

	return narrowItem({
		uuid: file.uuid,
		stableUUID: undefined,
		meta: {
			type: "decoded",
			data: {
				name,
				mime,
				size: file.size,
				version: file.version,
				key: file.fileKey,
				created: file.timestamp,
				modified: file.timestamp
			}
		},
		parent: file.uuid,
		size: file.size,
		favorited: false,
		region: file.region,
		bucket: file.bucket,
		timestamp: file.timestamp,
		chunks: file.chunks,
		// The SDK's own per-file verdict, carried through rather than synthesized — it is the only
		// gate on whether a thumbnail can be made. `stableUUID` stays undefined by contract: a
		// public link reports no whole-life id, so any drive operation on this item is rejected.
		canMakeThumbnail: file.canMakeThumbnail
	})
}

// True only for a `linkedFileIntoDriveItem` fabrication: a plain "file" arm whose `parent` equals its
// OWN uuid. A genuine owned file's parent is always a real, distinct directory (or the account root);
// the two DriveItem arms that legitimately self-parent for their own reasons (sharedRootFile,
// sharedRootDirectory — see narrowFile/narrowDir's own comments) tag as a DIFFERENT `.type`, so this
// stays unique to the chat/note-embed adapter's own output. Gates destructive drive actions (rename/
// move/trash/share/versions — the preview overlay's header menu) out of a preview opened
// from an embed: the item is neither owned nor a real tree member, so a mutation attempted against it
// would at best error against the backend and at worst act on a same-uuid file the viewer happens to
// also own — never a case this app should surface UI for.
export function isLinkedEmbedItem(item: DriveItem): boolean {
	return item.type === "file" && item.data.parent === item.data.uuid
}

// The two ROOT shared arms: the only ones whose shareSource is a SharedRootItem (removeSharedItem's
// argument) and whose rows are listed once per receiver.
export type SharedRootDriveItem = Extract<DriveItem, { type: "sharedRootDirectory" | "sharedRootFile" }>

export function isSharedRootDriveItem(item: DriveItem): item is SharedRootDriveItem {
	return item.type === "sharedRootDirectory" || item.type === "sharedRootFile"
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

// The "last modified" instant both the sort key and the displayed date read, so the two never
// disagree: a file's meta `modified`, a directory's meta `created`, else the upload timestamp.
export function lastModifiedOf(item: DriveItem): bigint {
	const base = asDirectoryOrFile(item)

	return base.type === "file"
		? (base.data.decryptedMeta?.modified ?? base.data.timestamp)
		: (base.data.decryptedMeta?.created ?? base.data.timestamp)
}

// Every directory arm, owned or shared.
export type DirectoryLikeItem = Extract<DriveItem, { type: "directory" | "sharedDirectory" | "sharedRootDirectory" }>

// asDirectoryOrFile(item).type === "directory" without allocating a wrapper for the shared arms.
export function isDirectoryItem(item: DriveItem): item is DirectoryLikeItem {
	return item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory"
}

// Directories carry no mime.
export function driveItemMime(item: DriveItem): string | undefined {
	const base = asDirectoryOrFile(item)
	return base.type === "file" ? base.data.decryptedMeta?.mime : undefined
}

// Rebuilds the SDK's AnyDirWithContext from a directory-arm DriveItem — the shape every
// category-dispatched dir op (zip download, getDirSize, …) needs so an UNTAGGED union match lands on
// the right arm. A plain owned directory needs no wrapper (data is already an AnyNormalDir). A
// sharedRootDirectory's role is required at the type level, so its wrapper always builds. A nested
// sharedDirectory's role is only ever present via the fetcher's spread (queries/drive.ts) — if it's
// missing there is no correct arm to dispatch to, so this throws rather than let the caller fall
// through to the owned arm and mis-list/mis-decrypt a share silently.
export function toAnyDirWithContext(item: DirectoryLikeItem): AnyDirWithContext {
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

// A selection as the SDK's item-taking ops want it (zip download, copy). A file's data is already a
// structural AnyFile. A directory is not: AnyDirWithContext is an UNTAGGED union, so a flattened shared
// directory's bare Dir-shaped data would match AnyNormalDir and be listed and decrypted through the
// OWNED code path instead of the share's — toAnyDirWithContext rebuilds the real wrapper.
export function narrowToSdkItems(items: readonly DriveItem[]): (AnyFile | AnyDirWithContext)[] {
	return items.map(item => {
		switch (item.type) {
			case "file":
			case "sharedFile":
			case "sharedRootFile":
				return item.data
			case "directory":
			case "sharedDirectory":
			case "sharedRootDirectory":
				return toAnyDirWithContext(item)
		}
	})
}

// Resolves the OTHER party's identity for a shared item (in the sharedIn context, the sharer). The
// root and file arms carry the role directly; a nested sharedDirectory reads its spread `sharingRole`
// (a SharedDir has no native role). A non-shared arm, a nested directory without the spread, or a
// role no known shape can be read from, resolves to null. The dual-surface unwrap itself (uniffi `.inner`
// vs wasm `.Sharer`/`.Receiver`) lives in shareIdentityFromRole (@filen/shared).
export function getSharerIdentity(item: DriveItem): ShareIdentity | null {
	switch (item.type) {
		case "sharedRootFile":
		case "sharedFile":
		case "sharedRootDirectory":
		case "sharedDirectory":
			return shareIdentityFromRole(item.data.sharingRole)
		default:
			return null
	}
}

// Insert an incoming item into a cached listing, replacing (never duplicating) whatever row it collides
// with: the same uuid, or a same-name row it supersedes (case-insensitive, trimmed, and only when both names
// are known — an undecryptable row has none). Covers createDirectory's idempotent-existing-directory return:
// the backend hands back the SAME uuid it already returned last time, so the stale cached row is dropped and
// the fresh one appended, net item count unchanged.
export { upsertItem as upsertDriveItem } from "@filen/shared"

function withData<T extends DriveItem>(row: T, update: (data: T["data"]) => T["data"]): T {
	return { ...row, data: update(row.data) }
}

// A cached row refreshed with the one attribute an in-place change set, and nothing else. It keeps its arm
// and sharing context (the Shared by me root lists an item once per receiver, each row unsharing its own)
// and every other field, which the change's result may carry outdated (a colour set since) or synthesized
// (a shared root's own parent and flag, when the change started from such a row).
export function withNameOf(row: DriveItem, renamed: DriveItem): DriveItem {
	const source = asDirectoryOrFile(renamed)

	switch (row.type) {
		case "directory":
		case "sharedDirectory":
		case "sharedRootDirectory": {
			if (source.type !== "directory") {
				return row
			}

			const { meta, decryptedMeta, undecryptable } = source.data

			return withData(row, data => ({ ...data, meta, decryptedMeta, undecryptable }))
		}

		case "file":
		case "sharedFile":
		case "sharedRootFile": {
			if (source.type !== "file") {
				return row
			}

			const { meta, decryptedMeta, undecryptable } = source.data

			return withData(row, data => ({ ...data, meta, decryptedMeta, undecryptable }))
		}
	}
}

export function withFavorited(row: DriveItem, favorited: boolean): DriveItem {
	return row.data.favorited === favorited ? row : withData(row, data => ({ ...data, favorited }))
}

export function withColor(row: DriveItem, color: DirColor): DriveItem {
	switch (row.type) {
		case "directory":
		case "sharedDirectory":
		case "sharedRootDirectory": {
			return row.data.color === color ? row : withData(row, data => ({ ...data, color }))
		}

		case "file":
		case "sharedFile":
		case "sharedRootFile": {
			return row
		}
	}
}
