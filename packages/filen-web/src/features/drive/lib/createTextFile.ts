import type { File as SdkFile } from "@filen/sdk-rs"
import { extensionOf } from "@/features/drive/lib/preview.logic"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { narrowItem, upsertDriveItem, type DriveItem } from "@/features/drive/lib/item"

// Appends the default extension when the trimmed name has none — mirrors mobile's own
// FileSystem.Paths.extname check (useDriveUpload.ts's createTextFile). Reuses extensionOf
// (preview.logic.ts) rather than a second extname parser, so a dotfile like ".gitignore" (no real
// extension by extensionOf's own leading-dot exclusion) also gets ".txt" appended, same as mobile.
export function normalizeTextFileName(name: string): string {
	return extensionOf(name) === "" ? `${name}.txt` : name
}

// Injected collaborators so the attempt is unit-testable without a worker or a query client —
// mirrors CreateDirectoryDeps's shape (createDirectory.ts), swapping the create call for the same
// whole-buffer uploadFileBytes op the editable-preview save path already uses (previewSave.logic.ts).
export interface CreateTextFileDeps {
	uploadFileBytes: (parentUuid: string | null, data: Uint8Array, name: string, mime: string) => Promise<SdkFile>
	patchListing: (parentUuid: string | null, updater: (prev: DriveItem[]) => DriveItem[]) => void
}

export type CreateTextFileOutcome =
	| { status: "success"; item: DriveItem }
	// A name clash against a directory, an invalid name, or any transport failure. The caller
	// surfaces the DTO's label.
	| { status: "error"; dto: ErrorDTO }

// One create-text-file attempt: upload a zero-byte "text/plain" buffer under `name` (mobile parity —
// useDriveUpload.ts's createTextFile writes an empty tmp file, never a placeholder line), narrow the
// result into a DriveItem, then patch the affected listing so the new file appears without a
// refetch. `name` is expected already normalized (normalizeTextFileName above) — this function does
// not re-derive the extension itself, mirroring runCreateDirectory's identical "caller trims" split.
export async function runCreateTextFile(deps: CreateTextFileDeps, parentUuid: string | null, name: string): Promise<CreateTextFileOutcome> {
	let created: SdkFile
	try {
		created = await deps.uploadFileBytes(parentUuid, new Uint8Array(0), name, "text/plain")
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	const item = narrowItem(created)
	deps.patchListing(parentUuid, prev => upsertDriveItem(prev, item))

	return { status: "success", item }
}
