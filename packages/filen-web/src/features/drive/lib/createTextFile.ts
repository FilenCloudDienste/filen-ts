import type { File as SdkFile } from "@filen/sdk-rs"
import { extensionOf } from "@/features/drive/lib/preview.logic"
import type { QuotaVerdict } from "@filen/shared"
import { asErrorDTO, plainErrorDTO } from "@/lib/sdk/errors"
import { checkUploadQuota, quotaExceededMessage } from "@/features/drive/lib/quota"
import { type ActionOutcome } from "@/lib/actions/outcome"
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
export interface CreateFileDeps {
	uploadFileBytes: (parentUuid: string | null, data: Uint8Array, name: string, mime: string) => Promise<SdkFile>
	patchListing: (parentUuid: string | null, updater: (prev: DriveItem[]) => DriveItem[]) => void
	// An upload onto a taken name makes a new version of that file, never a new one.
	nameTaken: (parentUuid: string | null, name: string) => Promise<boolean>
	// The storage pre-flight; left out, the account's (checkUploadQuota). An empty file always fits.
	checkQuota?: (neededBytes: bigint) => Promise<QuotaVerdict>
}

// "taken" leaves every file as it was; the caller asks for another name.
export type CreateFileOutcome = ActionOutcome<DriveItem> | { status: "taken" }

// One create-new-file attempt: refuse a taken name, upload `data` under `name`, narrow the result into
// a DriveItem, then patch the affected listing so the new file appears without a refetch. `name` is
// expected already normalized — this function does not re-derive the extension itself, mirroring
// runCreateDirectory's identical "caller trims" split. "error" is an invalid name or any transport
// failure; the caller surfaces the DTO's label.
export async function runCreateFile(
	deps: CreateFileDeps,
	parentUuid: string | null,
	name: string,
	data: Uint8Array,
	mime: string
): Promise<CreateFileOutcome> {
	const verdict = await (deps.checkQuota ?? checkUploadQuota)(BigInt(data.byteLength))

	// Tagged as the server's refusal so callers treat both alike.
	if (verdict.status === "exceeds") {
		return { status: "error", dto: plainErrorDTO(quotaExceededMessage(verdict), "MaxStorageReached") }
	}

	let created: SdkFile
	try {
		if (await deps.nameTaken(parentUuid, name)) {
			return { status: "taken" }
		}

		created = await deps.uploadFileBytes(parentUuid, data, name, mime)
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	const item = narrowItem(created)
	deps.patchListing(parentUuid, prev => upsertDriveItem(prev, item))

	return { status: "success", item }
}

// A zero-byte "text/plain" file (mobile parity — useDriveUpload.ts's createTextFile writes an empty
// tmp file, never a placeholder line).
export function runCreateTextFile(deps: CreateFileDeps, parentUuid: string | null, name: string): Promise<CreateFileOutcome> {
	return runCreateFile(deps, parentUuid, name, new Uint8Array(0), "text/plain")
}
