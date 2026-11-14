import type { File as SdkFile } from "@filen/sdk-rs"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"

export interface RemoteHeadDeps {
	getFileByStableUuid: (stableUuid: string) => Promise<SdkFile | undefined>
}

export type RemoteHead = { readonly kind: "current" } | { readonly kind: "changed"; readonly currentUuid: string | null }

// Whether `item` is still its lineage's newest version, asked before a new version of it is uploaded: a new version
// must be of the version the edits were made on. The lineage is followed by `stableUUID` (the uuid rotates with every
// save); "changed" names the newest version's uuid, null when the file is gone. A file without a lineage id has
// nothing to compare against and counts as current. A failed lookup rejects.
export async function checkRemoteHead(item: DriveItem, deps: RemoteHeadDeps): Promise<RemoteHead> {
	const base = asDirectoryOrFile(item)

	if (base.type !== "file" || base.data.stableUUID === undefined) {
		return { kind: "current" }
	}

	const head = await deps.getFileByStableUuid(base.data.stableUUID)

	return head?.uuid === base.data.uuid ? { kind: "current" } : { kind: "changed", currentUuid: head?.uuid ?? null }
}
