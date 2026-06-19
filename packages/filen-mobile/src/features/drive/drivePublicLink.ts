import auth from "@/lib/auth"
import { type DirPublicLinkRw, type FilePublicLink } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import { driveItemsQueryUpdate } from "@/features/drive/queries/useDriveItems.query"
import { driveItemPublicLinkStatusQueryUpdate } from "@/features/drive/queries/useDriveItemPublicLinkStatus.query"

export async function removeDirLink({ item, signal }: { item: DriveItem; signal?: AbortSignal }) {
	if (item.type !== "directory") {
		throw new Error("Invalid item type")
	}

	const { authedSdkClient } = await auth.getSdkClients()

	// SDK 0.4.27: removeDirLink takes the directory itself and resolves the link by the dir's uuid.
	// Passing the link (DirPublicLinkRw) sent the LINK uuid and failed with "public link not found".
	await authedSdkClient.removeDirLink(
		item.data,
		signal
			? {
					signal
				}
			: undefined
	)

	driveItemsQueryUpdate({
		params: {
			path: {
				type: "links",
				uuid: null
			}
		},
		updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
	})
}

export async function removeFileLink({ item, signal, link }: { item: DriveItem; signal?: AbortSignal; link: FilePublicLink }) {
	if (item.type !== "file") {
		throw new Error("Invalid item type")
	}

	const { authedSdkClient } = await auth.getSdkClients()

	await authedSdkClient.removeFileLink(
		item.data,
		link,
		signal
			? {
					signal
				}
			: undefined
	)

	driveItemsQueryUpdate({
		params: {
			path: {
				type: "links",
				uuid: null
			}
		},
		updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
	})
}

export async function enablePublicLink({
	item,
	signal,
	onProgress
}: {
	item: DriveItem
	signal?: AbortSignal
	onProgress?: (bytesDownloaded: number, totalBytes: number | undefined) => void
}) {
	if (item.type !== "directory" && item.type !== "file") {
		throw new Error("Invalid item type")
	}

	const { authedSdkClient } = await auth.getSdkClients()

	if (item.type === "directory") {
		let status = await authedSdkClient.getDirLinkStatus(
			item.data,
			signal
				? {
						signal
					}
				: undefined
		)

		if (status) {
			return {
				type: "directory" as const,
				link: status
			}
		}

		status = await authedSdkClient.publicLinkDir(
			item.data,
			onProgress
				? {
						onProgress: (bytesDownloaded, totalBytes) => {
							onProgress(Number(bytesDownloaded), totalBytes ? Number(totalBytes) : undefined)
						}
					}
				: undefined,
			signal
				? {
						signal
					}
				: undefined
		)

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
			updater: () => ({
				type: "directory" as const,
				status
			})
		})

		return {
			type: "directory" as const,
			link: status
		}
	} else {
		let status = await authedSdkClient.getFileLinkStatus(
			item.data,
			signal
				? {
						signal
					}
				: undefined
		)

		if (status) {
			return {
				type: "file" as const,
				link: status
			}
		}

		status = await authedSdkClient.publicLinkFile(
			item.data,
			signal
				? {
						signal
					}
				: undefined
		)

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
			updater: () => ({
				type: "file" as const,
				status
			})
		})

		return {
			type: "file" as const,
			link: status
		}
	}
}

export async function disablePublicLink({ item, signal }: { item: DriveItem; signal?: AbortSignal }) {
	if (item.type !== "directory" && item.type !== "file") {
		throw new Error("Invalid item type")
	}

	const { authedSdkClient } = await auth.getSdkClients()

	if (item.type === "directory") {
		const status = await authedSdkClient.getDirLinkStatus(
			item.data,
			signal
				? {
						signal
					}
				: undefined
		)

		if (!status) {
			return
		}

		// SDK 0.4.27: removeDirLink takes the directory, not the link. getDirLinkStatus above is only
		// the "is there a link to remove?" guard; the removal itself keys off the dir's uuid.
		await authedSdkClient.removeDirLink(
			item.data,
			signal
				? {
						signal
					}
				: undefined
		)

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
	} else {
		const status = await authedSdkClient.getFileLinkStatus(
			item.data,
			signal
				? {
						signal
					}
				: undefined
		)

		if (!status) {
			return
		}

		await authedSdkClient.removeFileLink(
			item.data,
			status,
			signal
				? {
						signal
					}
				: undefined
		)

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
}

export async function updatePublicLink({
	item,
	signal,
	link
}: {
	item: DriveItem
	signal?: AbortSignal
	link:
		| {
				type: "directory"
				link: DirPublicLinkRw
		  }
		| {
				type: "file"
				link: FilePublicLink
		  }
}) {
	if (item.type !== "directory" && item.type !== "file") {
		throw new Error("Invalid item type")
	}

	const { authedSdkClient } = await auth.getSdkClients()

	if (item.type === "directory") {
		if (link.type !== "directory") {
			throw new Error("Invalid link type for directory")
		}

		const status = await authedSdkClient.getDirLinkStatus(
			item.data,
			signal
				? {
						signal
					}
				: undefined
		)

		if (!status) {
			return
		}

		const merged: DirPublicLinkRw = {
			...status,
			...link.link
		}

		await authedSdkClient.updateDirLink(
			item.data,
			merged,
			signal
				? {
						signal
					}
				: undefined
		)

		driveItemPublicLinkStatusQueryUpdate({
			params: {
				uuid: item.data.uuid
			},
			updater: () => ({
				type: "directory" as const,
				status: merged
			})
		})
	} else {
		if (link.type !== "file") {
			throw new Error("Invalid link type for file")
		}

		const status = await authedSdkClient.getFileLinkStatus(
			item.data,
			signal
				? {
						signal
					}
				: undefined
		)

		if (!status) {
			return
		}

		const merged: FilePublicLink = {
			...status,
			...link.link
		}

		await authedSdkClient.updateFileLink(
			item.data,
			merged,
			signal
				? {
						signal
					}
				: undefined
		)

		driveItemPublicLinkStatusQueryUpdate({
			params: {
				uuid: item.data.uuid
			},
			updater: () => ({
				type: "file" as const,
				status: merged
			})
		})
	}
}
