import auth from "@/lib/auth"
import { SharedRootItem, type Contact } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import { driveItemsQueryUpdate } from "@/features/drive/queries/useDriveItems.query"
import cache from "@/lib/cache"

/**
 * Share a single owned file or directory with another Filen user. Dispatches
 * to the right SDK call based on the item type. Re-encrypts directory
 * contents under the recipient's public key (the SDK handles the heavy
 * lifting; we pass a `undefined` progress callback for now). Throws on
 * error so callers can wrap in `run()` / `runBulk` for UI feedback.
 */
export async function shareWithFilenUser({ item, contact, signal }: { item: DriveItem; contact: Contact; signal?: AbortSignal }) {
	if (item.type !== "directory" && item.type !== "file") {
		throw new Error("Invalid item type for share")
	}

	const { authedSdkClient } = await auth.getSdkClients()

	if (item.type === "directory") {
		await authedSdkClient.shareDir(item.data, contact, undefined, signal ? { signal } : undefined)

		return
	}

	await authedSdkClient.shareFile(item.data, contact, signal ? { signal } : undefined)
}

export async function removeShare({ item, signal, parentUuid }: { item: DriveItem; signal?: AbortSignal; parentUuid?: string }) {
	if (item.type !== "sharedRootDirectory" && item.type !== "sharedFile" && item.type !== "sharedRootFile") {
		throw new Error("Invalid item type")
	}

	const { authedSdkClient } = await auth.getSdkClients()

	await authedSdkClient.removeSharedItem(
		item.type === "sharedRootDirectory" ? new SharedRootItem.Dir(item.data) : new SharedRootItem.File(item.data),
		signal
			? {
					signal
				}
			: undefined
	)

	// Item leaves the user's sharedIn/sharedOut view entirely — forget caches.
	cache.forgetItem(item.data.uuid)

	if (parentUuid) {
		driveItemsQueryUpdate({
			params: {
				path: {
					type: "sharedOut",
					uuid: parentUuid
				}
			},
			updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
		})

		driveItemsQueryUpdate({
			params: {
				path: {
					type: "sharedIn",
					uuid: parentUuid
				}
			},
			updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
		})
	}

	driveItemsQueryUpdate({
		params: {
			path: {
				type: "sharedOut",
				uuid: null
			}
		},
		updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
	})

	driveItemsQueryUpdate({
		params: {
			path: {
				type: "sharedIn",
				uuid: null
			}
		},
		updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
	})
}
