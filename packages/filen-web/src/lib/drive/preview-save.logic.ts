import * as Comlink from "comlink"
import type { File as SdkFile } from "@filen/sdk-rs"
import { asDirectoryOrFile, narrowItem, upsertDriveItem, type DriveItem } from "@/lib/drive/item"
import { previewType } from "@/lib/drive/preview.logic"
import { type DriveVariant } from "@/lib/drive/preferences"
import { runOp, type ActionOutcome } from "@/lib/actions/outcome"
import { asErrorDTO } from "@/lib/sdk/errors"

// Editable-preview eligibility gate (mobile parity): only a decryptable text/code file inside the
// navigable "drive" variant — never trash/recents/favorites/sharedIn/sharedOut (no writable parent
// context, or a variant this app never lets a write reach), never markdown (its own view-source
// toggle re-renders the SAME read-only TextViewer, deliberately not this editable path), never an
// undecryptable row (nothing to encode a diff against).
export function isEditable(item: DriveItem, variant: DriveVariant): boolean {
	if (variant !== "drive") {
		return false
	}

	const base = asDirectoryOrFile(item)

	if (base.type !== "file" || base.data.undecryptable) {
		return false
	}

	const category = previewType(item)

	return category === "text" || category === "code"
}

// Injected collaborators so a save attempt is unit-testable without a worker or a query client —
// mirrors RunUploadDeps (lib/drive/upload.ts)/CreateDirectoryDeps (create-directory.ts). `patchListing`
// matches driveListingQueryUpdate's own (parentUuid, updater) shape (queries/drive.ts) rather than the
// global fan-out variant: a save never changes the item's parent, so exactly one listing can ever gain
// or lose a row from it — the single-parent patch is the one that can never leak a phantom row into an
// unrelated, already-cached listing (see upsertDriveItem's own unconditional-append behavior).
export interface PreviewSaveDeps {
	uploadFileBytes: (parentUuid: string | null, data: Uint8Array, name: string, mime: string) => Promise<SdkFile>
	patchListing: (parentUuid: string | null, updater: (items: DriveItem[]) => DriveItem[]) => void
	// The account's own root uuid — a real Dir.parent is never null (see sdk.worker.ts's own
	// ListDirectoryTarget comment), so a root-level item's parent must collapse back to the `null`
	// sentinel before it can resolve worker-side (resolveNormalDirParent) or key the right listing.
	rootUuid: string
}

function dropUuid(items: DriveItem[], uuid: string): DriveItem[] {
	return items.filter(existing => existing.data.uuid !== uuid)
}

// One save attempt: encode the edited buffer, transfer it into the worker's whole-buffer uploadFileBytes
// op (never cloned), then patch the item's own listing for the ROTATED uuid a content change always
// produces — mirrors restoreVersion's identical uuid-rotation reconcile (lib/drive/actions.ts):
// upsertDriveItem's name-collision dedup already drops the stale row (same parent, same name), and the
// explicit dropUuid below is the same defense-in-depth restoreVersion applies for a row whose meta
// isn't decodable enough to match on name alone. Never throws — a worker rejection (including an
// unresolvable parent, e.g. the containing directory was deleted from another session mid-edit) comes
// back as an error outcome; the caller degrades the editor to read-only rather than retrying against a
// parent that will only ever fail again (mobile parity).
export async function runPreviewSave(deps: PreviewSaveDeps, args: { item: DriveItem; content: string }): Promise<ActionOutcome<DriveItem>> {
	const { item, content } = args
	const base = asDirectoryOrFile(item)

	if (base.type !== "file") {
		// Unreachable in practice — isEditable already excludes every non-file arm — kept so the
		// narrow below (decryptedMeta.mime is file-arm-only) type-checks without a non-null assertion.
		const message = "runPreviewSave: not a file"
		return { status: "error", dto: { species: "plain", message, label: message } }
	}

	const name = base.data.decryptedMeta?.name ?? base.data.uuid
	const mime = base.data.decryptedMeta?.mime ?? ""
	const bytes = new TextEncoder().encode(content)
	// Root-sentinel collapse inlined rather than importing normalizeParentUuid (queries/drive.ts): the
	// .logic.ts split keeps this file framework-free (no queryClient import anywhere in it, direct or
	// transitive) — the one-line uuid compare isn't worth crossing that boundary for.
	const targetParent = base.data.parent === deps.rootUuid ? null : base.data.parent

	let uploaded: SdkFile
	try {
		uploaded = await runOp(deps.uploadFileBytes(targetParent, Comlink.transfer(bytes, [bytes.buffer]), name, mime))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	const newItem = narrowItem(uploaded)
	const oldUuid = base.data.uuid

	deps.patchListing(targetParent, prev => dropUuid(upsertDriveItem(prev, newItem), oldUuid))

	return { status: "success", item: newItem }
}
