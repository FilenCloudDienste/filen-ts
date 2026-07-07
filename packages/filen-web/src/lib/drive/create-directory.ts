import type { Dir } from "@filen/sdk-rs"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import { narrowItem, upsertDriveItem, type DriveItem } from "@/lib/drive/item"

// Injected collaborators so the attempt is unit-testable without a worker or a query client —
// mirrors runLoginAttempt/runResetAttempt's shape (see lib/auth/login-attempt.ts). No generation
// counter: unlike the two-factor dialog, InputDialog blocks dismissal while pending (see
// dismissal.logic.ts), so there is no "user canceled mid-flight" race to guard against here.
export interface CreateDirectoryDeps {
	createDirectory: (parentUuid: string | null, name: string) => Promise<Dir>
	patchListing: (parentUuid: string | null, updater: (prev: DriveItem[]) => DriveItem[]) => void
}

export type CreateDirectoryOutcome =
	// The backend is idempotent (see sdk.worker.ts's createDirectory) — a name that already exists
	// under this parent returns THAT directory unchanged rather than erroring, so "success" covers
	// both a genuinely new directory and a matched-existing one; the caller cannot and need not
	// distinguish the two.
	| { status: "success"; item: DriveItem }
	// A name clash against a FILE, an invalid name, or any transport failure. The caller surfaces
	// the DTO's label.
	| { status: "error"; dto: ErrorDTO }

// One create-directory attempt: create, narrow the result into a DriveItem, then patch the
// affected listing (add-or-replace by identity — see upsertDriveItem) so the new directory appears
// without a refetch.
export async function runCreateDirectory(
	deps: CreateDirectoryDeps,
	parentUuid: string | null,
	name: string
): Promise<CreateDirectoryOutcome> {
	let created: Dir
	try {
		created = await deps.createDirectory(parentUuid, name)
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	const item = narrowItem(created)
	deps.patchListing(parentUuid, prev => upsertDriveItem(prev, item))

	return { status: "success", item }
}
