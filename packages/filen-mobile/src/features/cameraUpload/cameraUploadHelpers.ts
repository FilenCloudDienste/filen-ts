import * as FileSystem from "expo-file-system"
import { xxHash32 } from "js-xxhash"
import { type Dir } from "@filen/sdk-rs"
import { type CameraUploadHashEntry } from "@/features/cameraUpload/cameraUploadState"
import { isTrashParent } from "@/lib/sdkUnwrap"
import { isHeicFile } from "@/lib/imageConversion"
import { extnameOf } from "@/lib/previewType"

export type CollisionParams = {
	iteration: number
	path: string
	// #15: whether the compress option is on. Under compress `asset.name` is already the
	// extension-STRIPPED stem (dedupTreeKey strips it because the uploaded extension is
	// unpredictable), so the suffix must be appended to the WHOLE stem — re-splitting it would
	// mis-read a dotted stem segment (e.g. "vacation.2024" → ext ".2024") and diverge from the
	// remote key. Defaults to false (the extension-splitting path) when omitted.
	compress?: boolean
	asset: {
		name: string
		/**
		 * Seconds-normalized creation timestamp used as the stable collision-suffix
		 * identity for this asset.
		 *
		 * Callers supply `String(Math.floor(effectiveCreationTimestamp(info) / 1000))`
		 * on the local side and `String(Math.floor(Number(meta?.created ?? 0) / 1000))`
		 * on the remote side. The two are symmetric because the upload pipeline sends
		 * `effectiveCreationTimestamp(info)` as the file's `created` metadata — the
		 * remote `meta.created` mirrors the exact value the local key was derived from
		 * (#B7: ONE timestamp rule on both sides). Flooring to seconds absorbs
		 * sub-second drift introduced by the SDK's EXIF-override (which may rewrite
		 * `meta.created` to DateTimeOriginal) and by network round-trips.
		 */
		contentHash: string
	}
}

/**
 * The deterministic collision suffix (WITHOUT extension) appended to an asset's
 * basename when its tree slot is already taken. Iteration selects the strategy:
 *
 *   0 — `_<contentHash>` (seconds-timestamp string)
 *   1 — `_<xxHash32(name + contentHash) as hex>`
 *
 * Returns null for iteration >= 2 (exhausted). #B2: the upload pipeline appends
 * this same suffix to the uploaded filename so the remote listing reproduces the
 * local collision key exactly. The suffix only ever contains `[a-z0-9_-]`
 * characters, so it never needs path-segment sanitization of its own.
 */
export function collisionNameSuffix({ iteration, asset }: { iteration: number; asset: CollisionParams["asset"] }): string | null {
	switch (iteration) {
		case 0: {
			return `_${asset.contentHash}`
		}

		case 1: {
			return `_${xxHash32(`${asset.name}_${asset.contentHash}`).toString(16)}`
		}

		default: {
			return null
		}
	}
}

/**
 * Generates a collision-resolved path for a camera upload asset.
 *
 * When multiple assets share the same filename, this function appends the
 * deterministic `collisionNameSuffix` to the basename (see above for the
 * iteration strategies and the local/remote symmetry contract).
 *
 * #E2: the path is composed by PLAIN string concatenation on the raw segments —
 * never via `Paths.join` (which percent-ENCODES segments) or
 * `normalizeFilePathForSdk` (which percent-DECODES them and corrupts literal
 * `%XX` sequences in real filenames). Keys must stay byte-identical to the raw
 * decrypted names on both sides.
 *
 * There are exactly TWO iterations (0 and 1). If two assets genuinely share
 * both the same name AND the same creation second they are indistinguishable
 * and collapse to the same slot by design (deterministic dedup across syncs).
 * Callers should treat 2 as the hard cap, NOT extend the switch.
 *
 * Returns null for iteration >= 2 (exhausted) or when the path is invalid
 * (no parent directory / degenerate basename).
 */
export function modifyAssetPathOnCollision({ iteration, path, asset, compress }: CollisionParams): string | null {
	const suffix = collisionNameSuffix({ iteration, asset })

	if (suffix === null) {
		return null
	}

	return applyCollisionSuffix({ path, name: asset.name, suffix, compress })
}

function applyCollisionSuffix({ path, name, suffix, compress }: { path: string; name: string; suffix: string; compress?: boolean }): string | null {
	// #15: under compress the name is ALREADY extension-stripped (dedupTreeKey), so keep it
	// whole — splitting off a trailing dotted segment as an "extension" would place the suffix
	// mid-stem ("vacation_<T>.2024") and diverge from the remote key ("vacation.2024_<T>", derived
	// from the uploaded `<full-stem>_<suffix>.<uploadExt>` name via dedupTreeKey). Otherwise split
	// the real trailing extension so the suffix lands before it ("img_0001_<T>.jpg").
	const ext = compress ? "" : extnameOf(name)
	const basename = compress ? name : FileSystem.Paths.basename(name, ext)
	const slashIndex = path.lastIndexOf("/")
	const parentDir = slashIndex > 0 ? path.slice(0, slashIndex) : slashIndex === 0 ? "/" : ""

	if (parentDir === "." || basename.length === 0 || parentDir.length === 0 || basename === ".") {
		return null
	}

	return `${parentDir === "/" ? "" : parentDir}/${basename}${suffix}${ext}`.toLowerCase().trim()
}

/**
 * Walks the collision iterations from an OCCUPIED `path` until a free tree slot is found. listLocal
 * and listRemote both resolve through here so one physical asset lands on the same key on both
 * sides. `name` is the raw asset name (dedupTreeKey is applied here); `sortSec` is the
 * seconds-floored effectiveCreationTimestamp that forms the collision identity. Returns the slot
 * and the suffix it carries (#B2: the upload bakes it into the filename), or null when the
 * iterations are exhausted or the path is degenerate.
 */
export function resolveCollisionSlot({
	tree,
	path,
	name,
	sortSec,
	compress,
	convertHeic
}: {
	tree: Record<string, unknown>
	path: string
	name: string
	sortSec: number
	compress: boolean
	convertHeic?: boolean
}): { path: string; suffix: string } | null {
	const asset = {
		name: dedupTreeKey({ path: name, compress, convertHeic }),
		contentHash: String(sortSec)
	}
	let slot = path
	let suffix = ""

	for (let iteration = 0; tree[slot]; iteration++) {
		const nextSuffix = collisionNameSuffix({ iteration, asset })

		if (nextSuffix === null) {
			return null
		}

		const nextSlot = applyCollisionSuffix({ path: slot, name: asset.name, suffix: nextSuffix, compress })

		if (nextSlot === null) {
			return null
		}

		slot = nextSlot
		suffix = nextSuffix
	}

	return { path: slot, suffix }
}

// Strip characters that would split a folder name into multiple path segments
// when joined with a filename. iOS `PHCollection.localIdentifier` (used as
// `Album.id`) has the format "<UUID>/L0/<NNN>" — passing it untreated into
// `FileSystem.Paths.join` would produce extra "/" segments and trip the
// strict `slashCount === 2` check inside `ensureParentDirectoryExists`.
export function sanitizePathSegment(s: string): string {
	return s.replace(/\//g, "_")
}

// Compute the server folder name for a camera-upload album. The folder is simply the
// album's TITLE (trimmed) — same-titled albums deliberately share one folder, matching
// the legacy app so users migrating from it reuse their existing folders instead of
// re-uploading into newly-named subfolders. Only "/" is sanitized (it would otherwise
// split the segment and trip the slashCount check in ensureParentDirectoryExists); the
// title is otherwise kept verbatim, casing included, so the created folder round-trips
// byte-for-byte with the remote listing's dedup key. Returns null when the title is
// empty after trimming — such an album can't form a valid folder segment and the caller
// must skip it.
export function albumFolderTitle(title: string): string | null {
	const trimmed = title.trim()

	if (trimmed.length === 0) {
		return null
	}

	return sanitizePathSegment(trimmed)
}

// Derive the dedup tree-key for a camera-upload asset path so that listLocal and listRemote resolve
// the SAME physical asset to the SAME key, accounting for the upload pipeline's extension rewrites.
//
// #15 — compress: `compress()` may rewrite e.g. `photo.png` → `photo.jpg`, but ONLY when the JPEG
// output is smaller — an outcome unknowable at listing time. The uploaded extension is therefore
// unpredictable, so the key is made extension-AGNOSTIC (strip the trailing extension). The local key
// (source ext) and the remote key (source ext when compression lost, `.jpg` when it won) collapse to
// the identical stem.
//
// convertHeic: the HEIC→JPG option rewrites ONLY `.heic`/`.heif`/`.heics`/`.heifs` → `.jpg`,
// deterministically (non-HEIC inputs upload unchanged). So the key NORMALIZES to the post-conversion
// name — a HEIC path maps to its `.jpg` form, everything else is kept verbatim. This is symmetric
// WITHOUT a side flag: listLocal maps a source `.heic` → `.jpg`; listRemote sees the already-converted
// `.jpg` (not HEIC) and leaves it verbatim — both land on `…/photo.jpg`. It deliberately does NOT
// strip the extension off every file: stripping collapsed genuinely-distinct non-HEIC siblings that
// share a stem (e.g. `doc.png` and `doc.mp4` both became `doc`), so one overwrote the other in the
// tree and was silently never backed up (data loss). compress dominates when both options are on.
//
// When neither option is on the full path (extension included) is kept verbatim, so genuinely
// different-extension siblings never merge.
//
// Also applied to bare filenames to derive the collision-suffix base, so the collision-resolved key
// gets the same transform on both sides.
export function dedupTreeKey({ path, compress, convertHeic }: { path: string; compress: boolean; convertHeic?: boolean }): string {
	if (compress) {
		return stripFilenameExtension(path)
	}

	if (convertHeic && isHeicFile(path)) {
		const ext = extnameOf(path)

		return ext.length === 0 ? path : `${path.slice(0, -ext.length)}.jpg`
	}

	return path
}

// Strip the trailing extension (the compress branch of `dedupTreeKey`).
export function stripFilenameExtension(name: string): string {
	const ext = extnameOf(name)

	if (ext.length === 0) {
		return name
	}

	return name.slice(0, -ext.length)
}

// #B7: ONE timestamp fallback rule for everything that derives an identity from an
// asset's creation time — the collision tree-key suffix, the collision-group sort
// AND the upload's `created` parameter. Because the upload sends this exact value
// as the file's `created` metadata, the remote listing's `meta.created` mirrors it
// and the local/remote dedup keys stay symmetric — including for assets whose
// creationTime is null (previously the key fell back to 0 while the upload sent
// modificationTime, so the remote key diverged and the asset re-evaluated forever).
// When BOTH timestamps are null the rule yields epoch 0, which still round-trips:
// the upload sends created=0 (transferCore null-guards instead of falsy-dropping
// it) and the remote side's `meta.created ?? 0` produces the same identity.
export function effectiveCreationTimestamp(info: { creationTime: number | null; modificationTime: number | null }): number {
	return info.creationTime ?? info.modificationTime ?? 0
}

// #E2: compose the LOCAL dedup tree path from raw segments — plain "/" joins, no
// `Paths.join` (percent-ENCODES its rest args) and no `normalizeFilePathForSdk`
// (percent-DECODES segments, corrupting literal `%XX` in real filenames — the
// eternal re-upload class). `folderTitle` is already sanitized (no "/") by
// `sanitizePathSegment`; for every name without decodable `%XX` sequences the
// result is byte-identical to the previous join+normalize pipeline.
export function composeLocalTreePath({ folderTitle, filename }: { folderTitle: string; filename: string }): string {
	return `/${folderTitle}/${filename}`.trim()
}

// #E2: derive the REMOTE dedup tree path from the raw decrypted `file.path` the SDK
// listing returns — NEVER percent-decoded (a literal "%20" in a decrypted name must
// stay "%20", and a literal "%2F" must never become a phantom "/" separator). Only
// guarantees the same outer shape the local composition has: trimmed + leading "/".
export function rawRemoteTreePath(path: string): string {
	const trimmed = path.trim()

	return trimmed.startsWith("/") ? trimmed : `/${trimmed}`
}

// Stale path strings (config toggles rewrite tree keys) never match again but would otherwise
// accumulate forever — keep the most recent few instead.
export const HASH_ENTRY_MAX_PATHS = 16

/**
 * Whether the shield entry covers a specific destination tree path. An entry without `paths`
 * (legacy shape) covers everything; a `paths`-carrying entry covers only the listed paths, so
 * an asset in several selected albums is still uploaded to each album folder once.
 */
export function hashEntryCoversPath(entry: CameraUploadHashEntry, path: string): boolean {
	return entry.paths === undefined || entry.paths.includes(path)
}

/**
 * Covered-path set for a REWRITTEN entry: the previous entry's paths plus the path just
 * uploaded/verified (deduped, capped). A previous legacy entry (no `paths`) contributes
 * nothing — the rewrite narrows it to the concrete path, which is what makes a legacy
 * cover-all entry start tracking real destinations once content changes.
 */
export function mergedHashEntryPaths(previous: CameraUploadHashEntry | undefined, path: string): string[] {
	const paths = previous?.paths ?? []

	return paths.includes(path) ? paths : [...paths, path].slice(-HASH_ENTRY_MAX_PATHS)
}

// #B4: secureStore key for the "Re-upload deleted photos" setting. Boolean; absent/false →
// current behavior (an md5-cache entry shields a remotely-deleted photo from re-upload).
// When true, camera upload mirrors the library: an entry whose key is present locally but
// absent from a CLEAN remote listing is dropped, so the photo naturally re-uploads.
// Read in cameraUpload.sync(); written by the camera upload settings screen via useSecureStore.
export const CAMERA_UPLOAD_REUPLOAD_DELETED_SECURE_STORE_KEY = "cameraUploadReuploadDeleted"

// Toggle the "after activation" camera-upload setting while keeping
// `activationTimestamp` consistent. Enabling stamps `now` so `listLocal`'s
// `gte(CREATION_TIME, activationTimestamp)` filter only matches assets created
// from this moment on; disabling resets it to 0 so the filter is inert.
// `now` is injected (rather than calling Date.now() here) so the transform
// stays pure and deterministically testable.
export function applyAfterActivationToggle<T extends { afterActivation: boolean; activationTimestamp: number }>({
	config,
	enabled,
	now
}: {
	config: T
	enabled: boolean
	now: number
}): T {
	return {
		...config,
		afterActivation: enabled,
		activationTimestamp: enabled ? now : 0
	}
}

// Whether a camera-upload destination directory is still usable as an upload target, given the
// result of a `getDirOptional(uuid)` lookup. `undefined` means the directory was permanently
// deleted on the server; a `Dir` whose parent is the trash means it was moved to the trash. In
// both cases it can no longer receive uploads, so the sync must exit early and the UI must surface
// the destination as unavailable. A `Dir` with any real parent is usable.
export function isDirUsable(dir: Dir | undefined): boolean {
	return dir !== undefined && !isTrashParent(dir.parent)
}

// expo-modules-core's SharedObjectRegistry reads its pairs map WITHOUT synchronization when
// converting a shared-object argument on the modules thread, while registrations and GC-driven
// deletions mutate the same map under a lock on the JS thread. A lookup racing a structural
// modification can spuriously miss a LIVE entry and reject the call with "Cannot use shared
// object that was already released" (issue #40). The object is provably alive in that case, so
// one immediate retry re-reads the registry and succeeds; a genuinely released object fails the
// retry too and the error propagates unchanged.
export function isReleasedSharedObjectError(error: unknown): boolean {
	return error instanceof Error && error.message.includes("shared object that was already released")
}

export async function withReleasedSharedObjectRetry<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn()
	} catch (error) {
		if (!isReleasedSharedObjectError(error)) {
			throw error
		}

		return await fn()
	}
}

/**
 * Whether a shield entry already accounts for this exact modification time at this path.
 *
 * The single predicate behind BOTH the delta gate and the upload gate. They have to agree: the
 * delta gate suppressing something the upload gate would have uploaded is a lost backup, so the
 * two read from one definition rather than from two copies that can drift.
 */
export function shieldCoversModification(
	entry: CameraUploadHashEntry | undefined,
	modificationTime: number | null | undefined,
	path: string
): boolean {
	return (
		entry !== undefined &&
		modificationTime != null &&
		// -1 is the "never verified" sentinel that legacy string entries migrate through, and must
		// never match a real timestamp.
		entry.verifiedModificationTime !== -1 &&
		entry.verifiedModificationTime === modificationTime &&
		// Per-path: an asset in several selected albums has one shield entry but several destination
		// paths — a match for one folder must not starve another.
		hashEntryCoversPath(entry, path)
	)
}

// Two-digit lowercase hex per byte value, built once so a digest costs 32 lookups instead of 32 toString+padStart.
const BYTE_HEX: readonly string[] = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"))

/**
 * Lowercase hex of a BLAKE3 digest as the SDK hands it over.
 *
 * File metadata carries the hash as 32 RAW BYTES through uniffi (`type Blake3Hash = ArrayBuffer`)
 * while every local hasher emits hex, so the two only meet after this.
 */
export function blake3ToHex(hash: ArrayBuffer): string {
	const bytes = new Uint8Array(hash)
	let hex = ""

	for (let index = 0; index < bytes.length; index++) {
		hex += BYTE_HEX[bytes[index] ?? 0] ?? ""
	}

	return hex
}

/**
 * Directory portion of a tree path.
 *
 * The remote content check is scoped to it rather than to the whole account: one asset can belong
 * to several selected albums and has to reach EVERY album folder, so content already sitting in
 * album A must not cancel the upload to album B. That is the same reason a shield entry tracks
 * `paths` instead of a single destination.
 */
export function parentTreePath(path: string): string {
	const index = path.lastIndexOf("/")

	return index <= 0 ? "/" : path.slice(0, index)
}
