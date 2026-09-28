import { type, type Type } from "arktype"
import { Semaphore } from "@filen/shared"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"
import { extensionOf, HEIC_EXTENSIONS } from "@/features/drive/lib/preview.logic"
import { transformHeicBytesOwned } from "@/features/preview/lib/heicTransform"
import { log } from "@/lib/log"

// ── Preference ───────────────────────────────────────────────────────────
// Mirrors filen-mobile's own convertHeicToJpg preference (DEFAULT_CONVERT_HEIC_TO_JPG_ENABLED = false,
// lib/imageConversion.ts): opt-in, off by default — a HEIC/HEIF upload is left untouched unless the
// user has explicitly turned this on.

const HEIC_UPLOAD_CONVERT_KV_KEY = "drive.convertHeicToJpgOnUpload.v1"
const heicUploadConvertSchema: Type<boolean> = type("boolean")

export async function getHeicUploadConvertPreference(): Promise<boolean> {
	return (await kvGetJson(HEIC_UPLOAD_CONVERT_KV_KEY, heicUploadConvertSchema)) ?? false
}

export async function setHeicUploadConvertPreference(next: boolean): Promise<void> {
	await kvSetJson(HEIC_UPLOAD_CONVERT_KV_KEY, next)
}

// ── Convert-on-upload ────────────────────────────────────────────────────

// Extension-only (mirrors preview.logic.ts's own needsImageTransform) — never a picked file's mime,
// which browsers frequently leave blank or wrong for HEIC/HEIF.
export function isHeicUploadCandidate(file: File): boolean {
	return HEIC_EXTENSIONS.has(extensionOf(file.name))
}

// Swaps a HEIC/HEIF upload's extension for ".jpg" — mirrors filen-mobile's own rename rule
// (maybeConvertHeicForUpload, useDriveUpload.ts): only the extension changes, the rest of the name
// (including any dots within it) is preserved untouched.
export function renameToJpg(name: string): string {
	const ext = extensionOf(name)

	return `${ext.length > 0 ? name.slice(0, -(ext.length + 1)) : name}.jpg`
}

export interface HeicUploadConvertDeps {
	// Takes ownership of `bytes`: the buffer may come back detached.
	transform: (bytes: Uint8Array) => Promise<Blob>
}

export const defaultHeicUploadConvertDeps: HeicUploadConvertDeps = { transform: transformHeicBytesOwned }

// Both upload entry points start every file's conversion at once. Without a bound, a large HEIC batch
// would read every source file into memory together while the single worker decodes them one by one.
// Two keeps the worker fed (the next file is read while the current one decodes); SDK upload
// concurrency is untouched.
const heicConvertLock = new Semaphore(2)

// Re-encodes a picked HEIC/HEIF File to JPEG before it reaches the upload pipeline, when the user's
// preference is on — mirrors filen-mobile's maybeConvertHeicForUpload (useDriveUpload.ts). A non-HEIC
// file, or the preference off, returns the original File untouched (no bytes ever read). A failed
// conversion also falls back to the original rather than throwing — an opportunistic re-encode must
// never block the upload it was meant to improve.
export async function maybeConvertHeicUpload(deps: HeicUploadConvertDeps, file: File, enabled: boolean): Promise<File> {
	if (!enabled || !isHeicUploadCandidate(file)) {
		return file
	}

	await heicConvertLock.acquire()

	try {
		const bytes = new Uint8Array(await file.arrayBuffer())
		const jpeg = await deps.transform(bytes)

		return new File([jpeg], renameToJpg(file.name), { type: "image/jpeg", lastModified: file.lastModified })
	} catch (e) {
		log.error("heic-upload-convert", e)

		return file
	} finally {
		heicConvertLock.release()
	}
}

export interface HeicUploadDeps {
	convert: HeicUploadConvertDeps
	readPreference: () => Promise<boolean>
}

export const defaultHeicUploadDeps: HeicUploadDeps = {
	convert: defaultHeicUploadConvertDeps,
	readPreference: getHeicUploadConvertPreference
}

// Does convert-on-upload apply to this batch? One definition, shared by the flat upload (startUploads)
// and the directory walk (runDirectoryUpload), so a new upload entry point can never silently skip the
// preference again. The kv read happens ONCE per batch and only when the batch actually holds a
// candidate — every other batch skips the storage round trip entirely. Deliberately only the GATE: the
// conversion itself stays per file inside each caller's own fan-out, so the first converted file starts
// uploading (and shows a transfer row) while the rest are still decoding. A failed read counts as off:
// the batch then uploads its originals, as a failed conversion would.
export async function heicUploadConversionEnabled(deps: HeicUploadDeps, files: readonly File[]): Promise<boolean> {
	if (!files.some(isHeicUploadCandidate)) {
		return false
	}

	try {
		return await deps.readPreference()
	} catch (e) {
		log.error("heic-upload-pref", e)

		return false
	}
}
