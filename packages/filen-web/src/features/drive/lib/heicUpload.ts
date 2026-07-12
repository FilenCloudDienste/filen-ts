import { type, type Type } from "arktype"
import { kvGetJson, kvSetJson } from "@/lib/storage/adapter"
import { extensionOf, HEIC_EXTENSIONS } from "@/features/drive/lib/preview.logic"
import { transformHeicBytes } from "@/features/preview/lib/heicTransform"
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
	transform: (bytes: Uint8Array) => Promise<Blob>
}

export const defaultHeicUploadConvertDeps: HeicUploadConvertDeps = { transform: transformHeicBytes }

// Re-encodes a picked HEIC/HEIF File to JPEG before it reaches the upload pipeline, when the user's
// preference is on — mirrors filen-mobile's maybeConvertHeicForUpload (useDriveUpload.ts). A non-HEIC
// file, or the preference off, returns the original File untouched (no bytes ever read). A failed
// conversion also falls back to the original rather than throwing — an opportunistic re-encode must
// never block the upload it was meant to improve.
export async function maybeConvertHeicUpload(deps: HeicUploadConvertDeps, file: File, enabled: boolean): Promise<File> {
	if (!enabled || !isHeicUploadCandidate(file)) {
		return file
	}

	try {
		const bytes = new Uint8Array(await file.arrayBuffer())
		const jpeg = await deps.transform(bytes)

		return new File([jpeg], renameToJpg(file.name), { type: "image/jpeg", lastModified: file.lastModified })
	} catch (e) {
		log.error("heic-upload-convert", e)

		return file
	}
}
