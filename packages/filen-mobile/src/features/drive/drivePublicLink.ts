import auth from "@/lib/auth"
import { type DirPublicLinkRw, type FilePublicLink, type PasswordState, type PublicLinkExpiration } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import { driveItemsQueryUpdate } from "@/features/drive/queries/useDriveItems.query"
import { driveItemPublicLinkStatusQueryUpdate } from "@/features/drive/queries/useDriveItemPublicLinkStatus.query"

// A status the caller already read (the Manage Public Link screen's query), passed to skip the SDK's
// status call: two HTTP requests per call, with no SDK-side cache.
export type KnownPublicLinkStatus =
	| {
			type: "directory"
			status: DirPublicLinkRw
	  }
	| {
			type: "file"
			status: FilePublicLink
	  }

export async function enablePublicLink({
	item,
	knownAbsent
}: {
	item: DriveItem
	// The caller just read the status and found no link, so the existence check is skipped.
	knownAbsent?: boolean
}) {
	if (item.type !== "directory" && item.type !== "file") {
		throw new Error("Invalid item type")
	}

	const { authedSdkClient } = await auth.getSdkClients()

	// A link made elsewhere since the caller's read is kept (never a second one) and cached like a new one.
	const known: KnownPublicLinkStatus =
		item.type === "directory"
			? {
					type: "directory",
					status:
						(knownAbsent ? undefined : await authedSdkClient.getDirLinkStatus(item.data)) ??
						(await authedSdkClient.publicLinkDir(item.data, undefined))
				}
			: {
					type: "file",
					status:
						(knownAbsent ? undefined : await authedSdkClient.getFileLinkStatus(item.data)) ??
						(await authedSdkClient.publicLinkFile(item.data))
				}

	driveItemsQueryUpdate({
		params: {
			path: {
				type: "links",
				uuid: null
			}
		},
		updater: prev => [...prev.filter(i => i.data.uuid !== item.data.uuid), item]
	})

	driveItemPublicLinkStatusQueryUpdate({
		params: {
			uuid: item.data.uuid
		},
		updater: () => known
	})

	return known.type === "directory"
		? {
				type: known.type,
				link: known.status
			}
		: {
				type: known.type,
				link: known.status
			}
}

export async function disablePublicLink({ item, known }: { item: DriveItem; known?: KnownPublicLinkStatus }) {
	if (item.type !== "directory" && item.type !== "file") {
		throw new Error("Invalid item type")
	}

	const { authedSdkClient } = await auth.getSdkClients()

	if (item.type === "directory") {
		const status = known?.type === "directory" ? known.status : await authedSdkClient.getDirLinkStatus(item.data)

		// SDK 0.4.27: removeDirLink takes the directory, not the link. getDirLinkStatus above is only
		// the "is there a link to remove?" guard; the removal itself keys off the dir's uuid.
		if (status) {
			await authedSdkClient.removeDirLink(item.data)
		}
	} else {
		const status = known?.type === "file" ? known.status : await authedSdkClient.getFileLinkStatus(item.data)

		if (status) {
			await authedSdkClient.removeFileLink(item.data, status)
		}
	}

	// No link to remove means it was disabled elsewhere, while the caches still show it.
	driveItemsQueryUpdate({
		params: {
			path: {
				type: "links",
				uuid: null
			}
		},
		updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
	})

	driveItemPublicLinkStatusQueryUpdate({
		params: {
			uuid: item.data.uuid
		},
		updater: () => null
	})
}

// The link fields the Manage Public Link screen edits. A save writes only these onto the link.
export type PublicLinkEdits = {
	password?: PasswordState
	expiration?: PublicLinkExpiration
	downloadable?: boolean
}

// "gone": the link was disabled elsewhere. "replaced": another link took its place. Neither is written
// to; the status cache takes the server's answer instead.
export type PublicLinkUpdateOutcome = "updated" | "gone" | "replaced"

export async function updatePublicLink({
	item,
	held,
	edits
}: {
	item: DriveItem
	// The link status the edits were made against.
	held: KnownPublicLinkStatus
	edits: PublicLinkEdits
}): Promise<PublicLinkUpdateOutcome> {
	if (item.type !== "directory" && item.type !== "file") {
		throw new Error("Invalid item type")
	}

	const { authedSdkClient } = await auth.getSdkClients()

	if (item.type === "directory") {
		if (held.type !== "directory") {
			throw new Error("Invalid link type for directory")
		}

		// dir/link/edit is keyed by the directory, so it can't bring back a link disabled elsewhere: no read.
		const link: DirPublicLinkRw = {
			...held.status,
			password: edits.password ?? held.status.password,
			enableDownload: edits.downloadable ?? held.status.enableDownload,
			expiration: edits.expiration ?? held.status.expiration
		}

		await authedSdkClient.updateDirLink(item.data, link)

		driveItemPublicLinkStatusQueryUpdate({
			params: {
				uuid: item.data.uuid
			},
			updater: () => ({
				type: "directory" as const,
				status: link
			})
		})

		return "updated"
	} else {
		if (held.type !== "file") {
			throw new Error("Invalid link type for file")
		}

		// file/link/edit is keyed by the link uuid and enables that link: a write built on the held status
		// would re-publish a link disabled or replaced elsewhere.
		const current = await authedSdkClient.getFileLinkStatus(item.data)

		if (!current) {
			driveItemsQueryUpdate({
				params: {
					path: {
						type: "links",
						uuid: null
					}
				},
				updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
			})

			driveItemPublicLinkStatusQueryUpdate({
				params: {
					uuid: item.data.uuid
				},
				updater: () => null
			})

			return "gone"
		}

		if (current.linkUuid !== held.status.linkUuid) {
			driveItemPublicLinkStatusQueryUpdate({
				params: {
					uuid: item.data.uuid
				},
				updater: () => ({
					type: "file" as const,
					status: current
				})
			})

			return "replaced"
		}

		// Onto the current record, so fields changed elsewhere since the held read survive.
		const link: FilePublicLink = {
			...current,
			password: edits.password ?? current.password,
			downloadable: edits.downloadable ?? current.downloadable,
			expiration: edits.expiration ?? current.expiration
		}

		await authedSdkClient.updateFileLink(item.data, link)

		driveItemPublicLinkStatusQueryUpdate({
			params: {
				uuid: item.data.uuid
			},
			updater: () => ({
				type: "file" as const,
				status: link
			})
		})

		return "updated"
	}
}
