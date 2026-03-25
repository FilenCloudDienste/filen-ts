import { memo } from "react"
import MenuComponent, { type MenuButton } from "@/components/ui/menu"
import type { DriveItem } from "@/types"
import { router } from "expo-router"
import drive from "@/lib/drive"
import alerts from "@/lib/alerts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import { run } from "@filen/utils"
import { SharingRole_Tags, type FileVersion, type AnyDirWithContext, AnyDirWithContext_Tags } from "@filen/sdk-rs"
import * as FileSystem from "expo-file-system"
import transfers from "@/lib/transfers"
import { randomUUID } from "expo-crypto"
import { Platform, type StyleProp, type ViewStyle } from "react-native"
import * as MediaLibrary from "expo-media-library"
import offline from "@/lib/offline"
import { getPreviewType, listLocalDirectoryRecursive, normalizeFilePathForBlobUtil, unwrapAnyDirUuid } from "@/lib/utils"
import * as ReactNativeBlobUtil from "react-native-blob-util"
import mimeTypes from "mime-types"
import * as Sharing from "expo-sharing"
import type { DrivePath, SelectOptions } from "@/hooks/useDrivePath"
import { pack } from "@/lib/msgpack"
import { simpleDate } from "@/lib/time"
import { actionSheet } from "@/providers/actionSheet.provider"
import auth from "@/lib/auth"
import { Buffer } from "react-native-quick-crypto"
import { selectContacts } from "@/routes/contacts"

export type DriveItemMenuOrigin =
	| "drive"
	| "preview"
	| "trash"
	| "sharedIn"
	| "sharedOut"
	| "favorites"
	| "recents"
	| "links"
	| "offline"
	| "search"
	| "photos"

export function createMenuButtons({
	item,
	origin,
	parent,
	drivePath,
	isStoredOffline,
	isOnline,
	versions
}: {
	item: DriveItem
	origin: DriveItemMenuOrigin
	parent?: AnyDirWithContext
	drivePath: DrivePath
	isStoredOffline: boolean
	isOnline: boolean
	versions: FileVersion[]
}): MenuButton[] {
	const menuButtons: MenuButton[] = []
	const previewType = item.type === "file" || item.type === "sharedFile" ? getPreviewType(item.data.decryptedMeta?.name ?? "") : null
	// TODO: Fix isOwner check
	const isOwner =
		parent &&
		(parent.tag === AnyDirWithContext_Tags.Normal ||
			(parent.tag === AnyDirWithContext_Tags.Shared && parent.inner[0].shareInfo.tag === SharingRole_Tags.Sharer))

	if (
		(item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory") &&
		(origin === "drive" ||
			origin === "sharedIn" ||
			origin === "sharedOut" ||
			origin === "favorites" ||
			origin === "links" ||
			origin === "search" ||
			origin === "offline")
	) {
		menuButtons.push({
			id: "open",
			title: "tbd_open",
			onPress: () => {
				router.push({
					pathname: drivePath.selectOptions
						? "/driveSelect/[uuid]"
						: origin === "offline"
							? "/offline/[uuid]"
							: origin === "links"
								? "/links/[uuid]"
								: item.type === "directory"
									? "/tabs/drive/[uuid]"
									: !isOwner
										? "/sharedIn/[uuid]"
										: "/sharedOut/[uuid]",
					params: {
						uuid: item.data.uuid,
						selectOptions: drivePath.selectOptions ? Buffer.from(pack(drivePath.selectOptions)).toString("base64") : undefined
					}
				})
			}
		})
	}

	const downloadSubButtons: MenuButton[] = []

	if (
		(item.type === "file" ||
			item.type === "directory" ||
			item.type === "sharedFile" ||
			item.type === "sharedDirectory" ||
			item.type === "sharedRootDirectory") &&
		item.data.decryptedMeta
	) {
		downloadSubButtons.push({
			id: "downloadToDevice",
			title: "tbd_download_to_device",
			onPress: async () => {
				const result = await run(async defer => {
					if (!item.data.decryptedMeta) {
						throw new Error("Missing decrypted metadata")
					}

					const destination = Platform.select({
						ios:
							item.type === "file" || item.type === "sharedFile"
								? new FileSystem.File(
										FileSystem.Paths.join(FileSystem.Paths.document, "Downloads", item.data.decryptedMeta.name)
									)
								: new FileSystem.Directory(
										FileSystem.Paths.join(FileSystem.Paths.document, "Downloads", item.data.decryptedMeta.name)
									),
						default:
							item.type === "file" || item.type === "sharedFile"
								? new FileSystem.File(
										FileSystem.Paths.join(FileSystem.Paths.cache, randomUUID(), item.data.decryptedMeta.name)
									)
								: new FileSystem.Directory(
										FileSystem.Paths.join(FileSystem.Paths.cache, randomUUID(), item.data.decryptedMeta.name)
									)
					})

					defer(() => {
						if (Platform.OS === "android" && destination.parentDirectory.exists) {
							destination.parentDirectory.delete()
						}
					})

					if (!destination.parentDirectory.exists) {
						destination.parentDirectory.create({
							intermediates: true,
							idempotent: true
						})
					}

					if (destination.exists) {
						destination.delete()
					}

					await transfers.download({
						item,
						itemUuid: item.data.uuid,
						destination
					})

					if (Platform.OS === "android") {
						if ((item.type === "file" || item.type === "sharedFile") && destination instanceof FileSystem.File) {
							await ReactNativeBlobUtil.default.MediaCollection.copyToMediaStore(
								{
									name: item.data.decryptedMeta.name,
									parentFolder: "Filen",
									mimeType: item.data.decryptedMeta.mime
								},
								"Download",
								destination.uri
							)
						}

						if (
							(item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory") &&
							destination instanceof FileSystem.Directory
						) {
							const entries = listLocalDirectoryRecursive(destination)

							await Promise.all(
								entries.map(async entry => {
									if (entry instanceof FileSystem.Directory) {
										return
									}

									const normalizedEntryPath = normalizeFilePathForBlobUtil(entry.uri)
									const destinationUriNormalized = normalizeFilePathForBlobUtil(destination.uri)

									const parentFolder = FileSystem.Paths.join(
										"Filen",
										item.data.decryptedMeta?.name ?? item.data.uuid,
										FileSystem.Paths.dirname(normalizedEntryPath.slice(destinationUriNormalized.length))
									)
										.split("/")
										.map(segment => (segment.length > 0 ? decodeURIComponent(segment) : segment))
										.join("/")

									await ReactNativeBlobUtil.default.MediaCollection.copyToMediaStore(
										{
											name: decodeURIComponent(entry.name),
											parentFolder: parentFolder.startsWith("/") ? parentFolder.slice(1) : parentFolder,
											mimeType: mimeTypes.lookup(decodeURIComponent(entry.name)) || "application/octet-stream"
										},
										"Download",
										normalizedEntryPath
									)
								})
							)
						}
					}
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}
			}
		})
	}

	if (parent && !isStoredOffline) {
		downloadSubButtons.push({
			id: "makeAvailableOffline",
			title: "tbd_make_available_offline",
			onPress: async () => {
				if (item.type === "file") {
					const result = await run(async () => {
						return await offline.storeFile({
							file: item,
							parent
						})
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)

						return
					}
				} else {
					const result = await run(async () => {
						return await offline.storeDirectory({
							directory: item,
							parent
						})
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)

						return
					}
				}
			}
		})
	}

	if (
		(item.type === "file" || item.type === "sharedFile") &&
		(previewType === "image" || previewType === "video") &&
		item.data.decryptedMeta
	) {
		downloadSubButtons.push({
			id: "saveToPhotos",
			title: "tbd_save_to_photos",
			onPress: async () => {
				const result = await runWithLoading(async defer => {
					if (!item.data.decryptedMeta) {
						throw new Error("Missing decrypted metadata")
					}

					const destination = new FileSystem.File(
						FileSystem.Paths.join(FileSystem.Paths.cache, randomUUID(), item.data.decryptedMeta.name)
					)

					defer(() => {
						if (destination.parentDirectory.exists) {
							destination.parentDirectory.delete()
						}
					})

					if (!destination.parentDirectory.exists) {
						destination.parentDirectory.create({
							intermediates: true,
							idempotent: true
						})
					}

					if (destination.exists) {
						destination.delete()
					}

					await transfers.download({
						item,
						itemUuid: item.data.uuid,
						destination
					})

					// TODO: Add NSPhotoLibraryAddUsageDescription to Info.plist and ask for permissions on both iOS and Android
					await MediaLibrary.saveToLibraryAsync(destination.uri)
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}
			}
		})
	}

	if ((item.type === "file" || item.type === "sharedFile") && item.data.decryptedMeta) {
		downloadSubButtons.push({
			id: "export",
			title: "tbd_export",
			onPress: async () => {
				const result = await runWithLoading(async () => {
					if (!item.data.decryptedMeta) {
						throw new Error("Missing decrypted metadata")
					}

					const destination = new FileSystem.File(
						FileSystem.Paths.join(FileSystem.Paths.cache, randomUUID(), item.data.decryptedMeta.name)
					)

					if (!destination.parentDirectory.exists) {
						destination.parentDirectory.create({
							intermediates: true,
							idempotent: true
						})
					}

					if (destination.exists) {
						destination.delete()
					}

					const downloadResult = await transfers.download({
						item,
						itemUuid: item.data.uuid,
						destination
					})

					if (
						downloadResult.files.length === 0 ||
						downloadResult.directories.length > 0 ||
						!downloadResult.files[0] ||
						!destination.exists
					) {
						throw new Error("Downloaded item is not a file")
					}

					return destination
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}

				const shareResult = await run(async defer => {
					defer(() => {
						if (result.data.parentDirectory.exists) {
							result.data.parentDirectory.delete()
						}
					})

					// Small delay to ensure file is fully written before sharing
					await new Promise<void>(resolve => setTimeout(resolve, 100))

					await Sharing.shareAsync(result.data.uri, {
						mimeType: "text/plain",
						dialogTitle: result.data.name
					})
				})

				if (!shareResult.success) {
					console.error(shareResult.error)
					alerts.error(shareResult.error)

					return
				}
			}
		})
	}

	if (
		downloadSubButtons.length > 0 &&
		origin !== "offline" &&
		(item.type === "file" || item.type === "sharedFile" ? (item.data.decryptedMeta?.size ?? 0) > 0 : true) &&
		isOnline
	) {
		menuButtons.push({
			id: "download",
			title: "tbd_download",
			icon: "archive",
			subButtons: downloadSubButtons
		})
	}

	if (
		(item.type === "file" || item.type === "directory") &&
		(origin === "drive" ||
			origin === "sharedOut" ||
			origin === "favorites" ||
			origin === "links" ||
			origin === "recents" ||
			origin === "search") &&
		isOnline
	) {
		menuButtons.push({
			id: "share",
			title: "tbd_share",
			subButtons: [
				{
					id: "sharePublicLink",
					title: "tbd_share_public_link",
					onPress: () => {
						// TODO
					}
				},
				{
					id: "shareFilenUser",
					title: "tbd_share_filen_user",
					onPress: async () => {
						await selectContacts({
							multiple: false,
							userIdsToExclude: []
						})
					}
				}
			]
		})
	}

	if (
		(item.type === "file" || item.type === "directory") &&
		(origin === "drive" ||
			origin === "sharedOut" ||
			origin === "favorites" ||
			origin === "links" ||
			origin === "recents" ||
			origin === "search") &&
		isOnline
	) {
		menuButtons.push({
			id: "favorite",
			title: item.data.favorited ? "tbd_unfavorite" : "tbd_favorite",
			icon: "heart",
			checked: item.data.favorited,
			onPress: async () => {
				const result = await runWithLoading(async () => {
					return await drive.favorite({
						item,
						favorited: !item.data.favorited
					})
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}
			}
		})
	}

	if (
		origin === "drive" ||
		origin === "sharedOut" ||
		origin === "favorites" ||
		origin === "links" ||
		origin === "recents" ||
		origin === "search" ||
		origin === "offline"
	) {
		menuButtons.push({
			id: "info",
			title: "tbd_info",
			onPress: () => {
				router.push({
					pathname: "/driveItemInfo",
					params: {
						itemPackedBase64: Buffer.from(pack(item)).toString("base64")
					}
				})
			}
		})

		if (item.type === "file" && origin !== "offline" && versions.length > 0 && isOnline) {
			menuButtons.push({
				id: "versions",
				title: "tbd_versions",
				icon: "clock",
				subButtons: versions.map(
					version =>
						({
							id: `version_${version.uuid}`,
							title: simpleDate(Number(version.timestamp)),
							keepMenuOpenOnPress: Platform.OS === "android",
							onPress: () => {
								actionSheet.show({
									buttons: [
										{
											title: "tbd_restore_version",
											onPress: async () => {
												const promptResult = await run(async () => {
													return await prompts.alert({
														title: "tbd_restore_version",
														message: "tbd_are_you_sure_restore_version",
														cancelText: "tbd_cancel",
														okText: "tbd_restore"
													})
												})

												if (!promptResult.success) {
													console.error(promptResult.error)
													alerts.error(promptResult.error)

													return
												}

												if (promptResult.data.cancelled) {
													return
												}

												const result = await runWithLoading(async () => {
													await drive.restoreFileVersion({
														item,
														version
													})
												})

												if (!result.success) {
													console.error(result.error)
													alerts.error(result.error)

													return
												}
											}
										},
										{
											title: "tbd_delete_version",
											destructive: true,
											onPress: async () => {
												const promptResult = await run(async () => {
													return await prompts.alert({
														title: "tbd_delete_version",
														message: "tbd_are_you_sure_delete_version",
														cancelText: "tbd_cancel",
														okText: "tbd_delete"
													})
												})

												if (!promptResult.success) {
													console.error(promptResult.error)
													alerts.error(promptResult.error)

													return
												}

												if (promptResult.data.cancelled) {
													return
												}

												const result = await runWithLoading(async () => {
													await drive.deleteVersion({
														item,
														version
													})
												})

												if (!result.success) {
													console.error(result.error)
													alerts.error(result.error)

													return
												}
											}
										},
										{
											title: "tbd_cancel",
											cancel: true
										}
									]
								})
							}
						}) satisfies MenuButton
				)
			})
		}
	}

	if (
		item.type === "directory" &&
		(origin === "drive" ||
			origin === "sharedOut" ||
			origin === "favorites" ||
			origin === "links" ||
			origin === "recents" ||
			origin === "search") &&
		isOnline
	) {
		menuButtons.push({
			id: "color",
			title: "tbd_color",
			onPress: () => {
				router.push({
					pathname: "/changeDirectoryColor",
					params: {
						itemPackedBase64: Buffer.from(pack(item)).toString("base64")
					}
				})
			}
		})
	}

	if (
		(item.type === "file" || item.type === "directory") &&
		(origin === "drive" ||
			origin === "sharedOut" ||
			origin === "favorites" ||
			origin === "links" ||
			origin === "recents" ||
			origin === "search") &&
		isOnline
	) {
		menuButtons.push({
			id: "rename",
			title: "tbd_rename",
			icon: "edit",
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.input({
						title: "tbd_rename_item",
						message: "tbd_enter_new_name",
						defaultValue: item.data.decryptedMeta?.name ?? "",
						cancelText: "tbd_cancel",
						okText: "tbd_rename"
					})
				})

				if (!promptResult.success) {
					console.error(promptResult.error)
					alerts.error(promptResult.error)

					return
				}

				if (promptResult.data.cancelled || promptResult.data.type !== "string") {
					return
				}

				const newName = promptResult.data.value.trim()

				if (newName.length === 0) {
					return
				}

				const result = await runWithLoading(async () => {
					await drive.rename({
						item,
						newName
					})
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}
			}
		})

		menuButtons.push({
			id: "move",
			title: "tbd_move",
			icon: "edit",
			onPress: async () => {
				const driveRootUuidResult = await run(async () => {
					const { authedSdkClient } = await auth.getSdkClients()

					return authedSdkClient.root().uuid
				})

				if (!driveRootUuidResult.success) {
					console.error(driveRootUuidResult.error)
					alerts.error(driveRootUuidResult.error)

					return
				}

				router.push({
					pathname: "/driveSelect/[uuid]",
					params: {
						uuid: driveRootUuidResult.data,
						selectOptions: Buffer.from(
							pack({
								type: "single",
								files: false,
								directories: true,
								intention: "move",
								items: [item],
								id: randomUUID()
							} satisfies SelectOptions)
						).toString("base64")
					}
				})
			}
		})
	}

	// Removing offline files should only be allowed when inside the root of the offline view or when it is already stored offline
	if ((origin === "offline" && !drivePath.uuid) || isStoredOffline) {
		menuButtons.push({
			id: "removeOffline",
			title: "tbd_remove_offline",
			icon: "trash",
			destructive: true,
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.alert({
						title: "tbd_remove_offline_item",
						message: "tbd_confirm_remove_offline",
						cancelText: "tbd_cancel",
						okText: "tbd_remove_offline"
					})
				})

				if (!promptResult.success) {
					console.error(promptResult.error)
					alerts.error(promptResult.error)

					return
				}

				if (promptResult.data.cancelled) {
					return
				}

				const result = await runWithLoading(async () => {
					await offline.removeItem(item)
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}
			}
		})
	}

	if (origin === "links" && (item.type === "file" || item.type === "directory") && isOnline && !parent) {
		menuButtons.push({
			id: "removeLink",
			title: "tbd_remove_link",
			icon: "delete",
			destructive: true,
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.alert({
						title: "tbd_remove_link_item",
						message: "tbd_confirm_remove_link",
						cancelText: "tbd_cancel",
						okText: "tbd_remove_link"
					})
				})

				if (!promptResult.success) {
					console.error(promptResult.error)
					alerts.error(promptResult.error)

					return
				}

				if (promptResult.data.cancelled) {
					return
				}

				const result = await runWithLoading(async () => {
					await drive.removeShare({
						item,
						parentUuid: parent ? (unwrapAnyDirUuid(parent) ?? undefined) : undefined
					})
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}
			}
		})
	}

	if (
		((origin === "sharedIn" && !parent) ||
			(origin === "preview" &&
				!isOwner &&
				(item.type === "sharedFile" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory"))) &&
		isOnline &&
		!parent
	) {
		menuButtons.push({
			id: "removeShare",
			title: "tbd_remove_share",
			icon: "delete",
			destructive: true,
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.alert({
						title: "tbd_remove_share_item",
						message: "tbd_confirm_remove_share",
						cancelText: "tbd_cancel",
						okText: "tbd_remove_share"
					})
				})

				if (!promptResult.success) {
					console.error(promptResult.error)
					alerts.error(promptResult.error)

					return
				}

				if (promptResult.data.cancelled) {
					return
				}

				const result = await runWithLoading(async () => {
					await drive.removeShare({
						item,
						parentUuid: parent ? (unwrapAnyDirUuid(parent) ?? undefined) : undefined
					})
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}

				if ((item.type === "file" || item.type === "sharedFile") && origin === "preview" && router.canGoBack()) {
					router.back()
				}
			}
		})
	}

	if (
		((origin === "sharedOut" && !parent) ||
			(origin === "preview" &&
				isOwner &&
				(item.type === "sharedFile" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory"))) &&
		isOnline &&
		!parent
	) {
		menuButtons.push({
			id: "stopSharing",
			title: "tbd_stop_sharing",
			icon: "delete",
			destructive: true,
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.alert({
						title: "tbd_stop_sharing_item",
						message: "tbd_confirm_stop_sharing",
						cancelText: "tbd_cancel",
						okText: "tbd_stop_sharing"
					})
				})

				if (!promptResult.success) {
					console.error(promptResult.error)
					alerts.error(promptResult.error)

					return
				}

				if (promptResult.data.cancelled) {
					return
				}

				const result = await runWithLoading(async () => {
					await drive.removeShare({
						item
					})
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}

				if ((item.type === "file" || item.type === "sharedFile") && origin === "preview" && router.canGoBack()) {
					router.back()
				}
			}
		})
	}

	if (origin !== "trash" && origin !== "sharedIn" && origin !== "offline" && origin !== "recents" && isOnline) {
		menuButtons.push({
			id: "trash",
			title: "tbd_trash",
			icon: "trash",
			destructive: true,
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.alert({
						title: "tbd_trash_item",
						message: "tbd_confirm_trash",
						cancelText: "tbd_cancel",
						okText: "tbd_trash"
					})
				})

				if (!promptResult.success) {
					console.error(promptResult.error)
					alerts.error(promptResult.error)

					return
				}

				if (promptResult.data.cancelled) {
					return
				}

				const result = await runWithLoading(async () => {
					await drive.trash({
						item
					})
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}

				if (item.type === "file" && origin === "preview" && router.canGoBack()) {
					router.back()
				}
			}
		})
	}

	if ((item.type === "file" || item.type === "directory") && origin === "trash" && isOnline) {
		menuButtons.push({
			id: "restore",
			title: "tbd_restore",
			icon: "restore",
			onPress: async () => {
				const result = await runWithLoading(async () => {
					await drive.restore({
						item
					})
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}
			}
		})
	}

	if ((item.type === "file" || item.type === "directory") && (origin === "trash" || origin === "preview") && isOnline) {
		menuButtons.push({
			id: "deletePermanently",
			title: "tbd_delete_permanently",
			icon: "delete",
			destructive: true,
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.alert({
						title: "tbd_delete_permanently_item",
						message: "tbd_confirm_delete_permanently",
						cancelText: "tbd_cancel",
						okText: "tbd_delete_permanently"
					})
				})

				if (!promptResult.success) {
					console.error(promptResult.error)
					alerts.error(promptResult.error)

					return
				}

				if (promptResult.data.cancelled) {
					return
				}

				const result = await runWithLoading(async () => {
					await drive.deletePermanently({
						item
					})
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}

				if (item.type === "file" && origin === "preview" && router.canGoBack()) {
					router.back()
				}
			}
		})
	}

	return menuButtons
}

const Menu = memo(
	({
		item,
		children,
		origin,
		type,
		className,
		isAnchoredToRight,
		parent,
		onOpenMenu,
		onCloseMenu,
		drivePath,
		isStoredOffline,
		isOnline,
		versions,
		disabled,
		style
	}: {
		item: DriveItem
		children: React.ReactNode
		origin: DriveItemMenuOrigin
		type: React.ComponentPropsWithoutRef<typeof MenuComponent>["type"]
		className?: string
		isAnchoredToRight?: boolean
		parent?: AnyDirWithContext
		onOpenMenu?: () => void
		onCloseMenu?: () => void
		drivePath: DrivePath
		isStoredOffline: boolean
		isOnline: boolean
		versions: FileVersion[]
		disabled?: boolean
		style?: StyleProp<ViewStyle>
	}) => {
		const menuButtons = disabled
			? []
			: createMenuButtons({
					item,
					origin,
					parent,
					drivePath,
					isStoredOffline,
					isOnline,
					versions
				})

		return (
			<MenuComponent
				className={className}
				type={type}
				isAnchoredToRight={isAnchoredToRight}
				buttons={menuButtons}
				title={item.data.decryptedMeta?.name}
				onCloseMenu={onCloseMenu}
				onOpenMenu={onOpenMenu}
				disabled={disabled}
				style={style}
			>
				{children}
			</MenuComponent>
		)
	}
)

export default Menu
