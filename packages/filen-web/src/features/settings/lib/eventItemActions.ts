import type { Dir, File } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { resolveContainingDirectoryTarget, type RevealDeps } from "@/features/drive/lib/reveal"
import type { DriveNavigationTarget } from "@/features/drive/lib/navigate"
import type { EventItemRef } from "@/features/settings/lib/eventModel"
import type { ErrorDTO } from "@/lib/sdk/errors"

// The event dialog's two drive actions, both resolved on click only: "Show in Cloud Drive" finds the item as
// it is now, "Open location" the directory it sat in.

export interface EventItemLookupDeps {
	getFile: (uuid: string) => Promise<File | undefined>
	getFileByStableUuid: (stableUuid: string) => Promise<File | undefined>
	getDirectory: (uuid: string) => Promise<Dir | undefined>
}

// The item as it is now, or null once it is gone. A file follows its stable id through renames and new
// versions: by uuid alone, an edit leaves the old version resolving as it was.
export async function lookupEventItem(ref: EventItemRef, deps: EventItemLookupDeps): Promise<DriveItem | null> {
	if (ref.type === "directory") {
		const dir = ref.uuid === undefined ? undefined : await deps.getDirectory(ref.uuid)

		return dir === undefined ? null : narrowItem(dir)
	}

	let file: File | undefined

	if (ref.stableUuid !== undefined) {
		file = await deps.getFileByStableUuid(ref.stableUuid)
	} else if (ref.uuid !== undefined) {
		file = await deps.getFile(ref.uuid)

		if (file?.stableUUID !== undefined) {
			file = await deps.getFileByStableUuid(file.stableUUID)
		}
	}

	return file === undefined ? null : narrowItem(file)
}

// Where the drive opens to: a listing (revealing `reveal` in it when set), or the trash.
export type EventDriveDestination =
	| { type: "listing"; target: DriveNavigationTarget; reveal?: string }
	| { type: "trash"; reveal: string }
	| { type: "gone" }
	| { type: "error"; dto: ErrorDTO }

const ROOT_TARGET: DriveNavigationTarget = { to: "/drive/$", params: { _splat: "" } }

// The item's containing directory with the item revealed in it. A trashed item has no directory to walk
// up from: the trash lists it.
export async function itemDestination(item: DriveItem, revealDeps: RevealDeps): Promise<EventDriveDestination> {
	if (item.data.parent === "trash") {
		return { type: "trash", reveal: item.data.uuid }
	}

	const outcome = await resolveContainingDirectoryTarget(revealDeps, item)

	return outcome.status === "error"
		? { type: "error", dto: outcome.dto }
		: { type: "listing", target: outcome.target, reveal: item.data.uuid }
}

// The directory itself, opened: its parent's chain plus its own uuid.
export async function locationDestination(
	uuid: string,
	rootUuid: string | undefined,
	deps: Pick<EventItemLookupDeps, "getDirectory">,
	revealDeps: RevealDeps
): Promise<EventDriveDestination> {
	if (uuid === rootUuid) {
		return { type: "listing", target: ROOT_TARGET }
	}

	const dir = await deps.getDirectory(uuid)

	if (dir === undefined) {
		return { type: "gone" }
	}

	const item = narrowItem(dir)

	if (dir.parent === "trash") {
		return { type: "trash", reveal: uuid }
	}

	const outcome = await resolveContainingDirectoryTarget(revealDeps, item)

	if (outcome.status === "error") {
		return { type: "error", dto: outcome.dto }
	}

	const parentSplat = outcome.target.params._splat

	return { type: "listing", target: { to: "/drive/$", params: { _splat: parentSplat === "" ? uuid : `${parentSplat}/${uuid}` } } }
}
