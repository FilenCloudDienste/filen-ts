import auth from "@/lib/auth"
import { CreatedTime, DirColor, NonRootNormalItem } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import { unwrapParentUuid } from "@/lib/sdkUnwrap"
import { driveItemsQueryUpdateGlobal, driveItemsQueryUpdateRoot } from "@/features/drive/queries/useDriveItems.query"
import { itemFromModified } from "@/features/drive/driveModified"
import events from "@/lib/events"
import { applyMembershipPatch } from "@filen/shared"

// Replace a modified item in every listing under its parent and re-point an open preview / active search at it.
function replaceInListings({ previousUuid, item }: { previousUuid: string; item: Extract<DriveItem, { type: "directory" | "file" }> }) {
	const unwrappedParentUuid = unwrapParentUuid(item.data.parent)

	if (unwrappedParentUuid) {
		driveItemsQueryUpdateGlobal({
			parentUuid: unwrappedParentUuid,
			updater: prev => prev.map(i => (i.data.uuid === item.data.uuid ? item : i))
		})
	}

	events.emit("driveItemUpdated", {
		previousUuid,
		item
	})
}

export async function favorite({ item, favorited }: { item: DriveItem; favorited: boolean }) {
	if (item.type !== "directory" && item.type !== "file") {
		throw new Error("Invalid item type")
	}

	if (item.data.favorited === favorited) {
		return item
	}

	// Capture before the SDK reassigns `item`: an open preview matches by the uuid
	// it currently holds. (favorite keeps the uuid, but capturing first stays
	// correct and consistent with move/restoreFileVersion regardless.)
	const previousUuid = item.data.uuid

	const { authedSdkClient } = await auth.getSdkClients()
	const modifiedItem = await authedSdkClient.setFavorite(
		item.type === "directory" ? new NonRootNormalItem.Dir(item.data) : new NonRootNormalItem.File(item.data),
		favorited
	)

	item = itemFromModified(modifiedItem.inner[0])

	// The replace-only global patch can't add a newly-favorited item to the Favorites root.
	driveItemsQueryUpdateRoot("favorites", prev => applyMembershipPatch(prev, item, favorited))

	// Refresh an open preview showing this file (favorite badge in the header).
	replaceInListings({
		previousUuid,
		item
	})

	return item
}

export async function rename({ item, newName }: { item: DriveItem; newName: string }) {
	if (item.type !== "directory" && item.type !== "file") {
		throw new Error("Invalid item type")
	}

	if (item.data.decryptedMeta?.name === newName || newName.trim().length === 0) {
		return item
	}

	// Capture before the SDK reassigns `item` (see favorite above).
	const previousUuid = item.data.uuid

	const { authedSdkClient } = await auth.getSdkClients()

	const modifiedItem =
		item.type === "directory"
			? await authedSdkClient.updateDirMetadata(item.data, {
					name: newName,
					created: CreatedTime.Keep.new()
				})
			: await authedSdkClient.updateFileMetadata(item.data, {
					name: newName,
					mime: undefined,
					lastModified: undefined,
					created: CreatedTime.Keep.new()
				})

	item = itemFromModified(modifiedItem)

	// Refresh an open preview showing this file (new name in the header).
	replaceInListings({
		previousUuid,
		item
	})

	return item
}

export async function setDirColor({ item, color }: { item: DriveItem; color: DirColor }) {
	if (item.type !== "directory") {
		throw new Error("Invalid item type")
	}

	// Capture before reassignment — the uuid may rotate on a metadata write.
	const previousUuid = item.data.uuid

	const { authedSdkClient } = await auth.getSdkClients()
	const modifiedDir = await authedSdkClient.setDirColor(item.data, color)

	item = itemFromModified(modifiedDir)

	// Self-heal an open preview + an active subtree cache-search (Effect D replaces the
	// row by previousUuid and clears any tombstone) — color changed in place.
	replaceInListings({
		previousUuid,
		item
	})

	return item
}
