import { memo } from "react"
import MenuComponent, { type MenuButton } from "@/components/ui/menu"
import type { DriveItem } from "@/types"
import { router } from "expo-router"
import drive from "@/lib/drive"
import alerts from "@/lib/alerts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import { run } from "@filen/utils"
import * as FileSystem from "expo-file-system"
import transfers from "@/lib/transfers"
import { randomUUID } from "expo-crypto"
import { Platform, type StyleProp, type ViewStyle } from "react-native"
import * as MediaLibrary from "expo-media-library"
import offline from "@/lib/offline"
import { getPreviewType, listLocalDirectoryRecursive, normalizeFilePathForBlobUtil, getRealDriveItemParent } from "@/lib/utils"
import * as ReactNativeBlobUtil from "react-native-blob-util"
import mimeTypes from "mime-types"
import * as Sharing from "expo-sharing"
import type { DrivePath, SelectOptions } from "@/hooks/useDrivePath"
import { serialize } from "@/lib/serializer"
import auth from "@/lib/auth"
import { selectContacts } from "@/routes/contacts"

export function createMenuButtons({
	item,
	drivePath,
	isStoredOffline
}: {
	item: DriveItem
	drivePath: DrivePath
	isStoredOffline: boolean
}): MenuButton[] {
	const menuButtons: MenuButton[] = []
	const previewType =
		item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile"
			? getPreviewType(item.data.decryptedMeta?.name ?? "")
			: null

	const parentForOfflineStorage = getRealDriveItemParent({
		item,
		drivePath
	})

	const isOwner = drivePath.type !== "sharedIn"

	if (
		(item.type === "directory" || item.type === "sharedDirectory" || item.type === "sharedRootDirectory") &&
		(drivePath.type === "drive" ||
			drivePath.type === "sharedIn" ||
			drivePath.type === "sharedOut" ||
			drivePath.type === "favorites" ||
			drivePath.type === "links" ||
			drivePath.type === "offline" ||
			drivePath.type === "linked")
	) {
		menuButtons.push({
			id: "open",
			title: "tbd_open",
			onPress: () => {
				router.push({
					pathname: drivePath.selectOptions
						? "/driveSelect/[uuid]"
						: drivePath.type === "offline"
							? "/offline/[uuid]"
							: drivePath.type === "links"
								? "/links/[uuid]"
								: drivePath.type === "drive"
									? "/tabs/drive/[uuid]"
									: drivePath.type === "sharedIn"
										? "/sharedIn/[uuid]"
										: drivePath.type === "linked"
											? "/linkedDir/[uuid]"
											: drivePath.type === "sharedOut"
												? "/sharedOut/[uuid]"
												: "",
					params: {
						uuid: item.data.uuid,
						selectOptions: drivePath.selectOptions ? serialize(drivePath.selectOptions) : undefined,
						linked: drivePath.linked ? serialize(drivePath.linked) : undefined
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
			item.type === "sharedRootFile" ||
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
							item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile"
								? new FileSystem.File(
										FileSystem.Paths.join(FileSystem.Paths.document, "Downloads", item.data.decryptedMeta.name)
									)
								: new FileSystem.Directory(
										FileSystem.Paths.join(FileSystem.Paths.document, "Downloads", item.data.decryptedMeta.name)
									),
						default:
							item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile"
								? new FileSystem.File(FileSystem.Paths.join(FileSystem.Paths.cache, randomUUID()))
								: new FileSystem.Directory(FileSystem.Paths.join(FileSystem.Paths.cache, randomUUID()))
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
						destination
					})

					if (Platform.OS === "android") {
						if (
							(item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile") &&
							destination instanceof FileSystem.File
						) {
							await ReactNativeBlobUtil.default.MediaCollection.copyToMediaStore(
								{
									name: decodeURIComponent(item.data.decryptedMeta.name),
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

	if (parentForOfflineStorage && !isStoredOffline) {
		downloadSubButtons.push({
			id: "makeAvailableOffline",
			title: "tbd_make_available_offline",
			onPress: async () => {
				if (item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile") {
					const result = await run(async () => {
						return await offline.storeFile({
							file: item,
							parent: parentForOfflineStorage
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
							parent: parentForOfflineStorage
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
		(item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile") &&
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
						destination,
						hideProgress: true
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

	if ((item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile") && item.data.decryptedMeta) {
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
						destination,
						hideProgress: true
					})

					if (!downloadResult) {
						throw new Error("Download failed")
					}

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
		drivePath.type !== "offline" &&
		(item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile"
			? (item.data.decryptedMeta?.size ?? 0) > 0
			: true)
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
		(drivePath.type === "drive" ||
			drivePath.type === "sharedOut" ||
			drivePath.type === "favorites" ||
			drivePath.type === "links" ||
			drivePath.type === "recents" ||
			drivePath.type === "photos")
	) {
		menuButtons.push({
			id: "share",
			title: "tbd_share",
			subButtons: [
				{
					id: "sharePublicLink",
					title: "tbd_share_public_link",
					onPress: () => {
						router.push({
							pathname: "/publicLink",
							params: {
								item: serialize(item)
							}
						})
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
		(drivePath.type === "drive" ||
			drivePath.type === "sharedOut" ||
			drivePath.type === "favorites" ||
			drivePath.type === "links" ||
			drivePath.type === "recents" ||
			drivePath.type === "photos")
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
		drivePath.type === "drive" ||
		drivePath.type === "sharedOut" ||
		drivePath.type === "favorites" ||
		drivePath.type === "links" ||
		drivePath.type === "recents" ||
		drivePath.type === "offline" ||
		drivePath.type === "photos"
	) {
		menuButtons.push({
			id: "info",
			title: "tbd_info",
			onPress: () => {
				router.push({
					pathname: "/driveItemInfo",
					params: {
						item: serialize(item)
					}
				})
			}
		})

		if (item.type === "file" && drivePath.type !== "offline") {
			menuButtons.push({
				id: "versions",
				title: "tbd_versions",
				icon: "clock",
				onPress: () => {
					router.push({
						pathname: "/fileVersions",
						params: {
							item: serialize(item)
						}
					})
				}
			})
		}
	}

	if (
		item.type === "directory" &&
		(drivePath.type === "drive" ||
			drivePath.type === "sharedOut" ||
			drivePath.type === "favorites" ||
			drivePath.type === "links" ||
			drivePath.type === "recents")
	) {
		menuButtons.push({
			id: "color",
			title: "tbd_color",
			onPress: () => {
				router.push({
					pathname: "/changeDirectoryColor",
					params: {
						item: serialize(item)
					}
				})
			}
		})
	}

	if (
		(item.type === "file" || item.type === "directory") &&
		(drivePath.type === "drive" ||
			drivePath.type === "sharedOut" ||
			drivePath.type === "favorites" ||
			drivePath.type === "links" ||
			drivePath.type === "recents" ||
			drivePath.type === "photos")
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

		if (drivePath.type !== "photos") {
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
							selectOptions: serialize({
								type: "single",
								files: false,
								directories: true,
								intention: "move",
								items: [item],
								id: randomUUID()
							} satisfies SelectOptions)
						}
					})
				}
			})
		}
	}

	// Removing offline files should only be allowed when inside the root of the offline view or when it is already stored offline
	if ((drivePath.type === "offline" && !drivePath.uuid) || isStoredOffline) {
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

	if (
		((drivePath.type === "sharedIn" && !drivePath.uuid) ||
			(!isOwner &&
				(item.type === "sharedFile" ||
					item.type === "sharedRootFile" ||
					item.type === "sharedDirectory" ||
					item.type === "sharedRootDirectory"))) &&
		!drivePath.uuid
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
						parentUuid: drivePath.uuid ?? undefined
					})
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}

				// TODO: if we are in a preview, close the preview after removing the share
			}
		})
	}

	if (
		((drivePath.type === "sharedOut" && !drivePath.uuid) ||
			(isOwner &&
				(item.type === "sharedFile" ||
					item.type === "sharedRootFile" ||
					item.type === "sharedDirectory" ||
					item.type === "sharedRootDirectory"))) &&
		!drivePath.uuid
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

				// TODO: if we are in a preview, close the preview after stopping sharing the item
			}
		})
	}

	if (drivePath.type === "links" && (item.type === "file" || item.type === "directory") && !drivePath.uuid) {
		menuButtons.push({
			id: "disablePublicLink",
			title: "tbd_disable_public_link",
			icon: "delete",
			destructive: true,
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.alert({
						title: "tbd_disable_public_link",
						message: "tbd_confirm_disable_public_link",
						cancelText: "tbd_cancel",
						okText: "tbd_disable",
						destructive: true
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
					await drive.disablePublicLink({
						item
					})
				})

				if (!result.success) {
					console.error(result.error)
					alerts.error(result.error)

					return
				}

				// TODO: if we are in a preview, close the preview after
			}
		})
	}

	if (
		drivePath.type !== "trash" &&
		drivePath.type !== "sharedIn" &&
		drivePath.type !== "offline" &&
		drivePath.type !== "recents" &&
		drivePath.type !== "linked"
	) {
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

				// TODO: if we are in a preview, close the preview after trashing the item
			}
		})
	}

	if ((item.type === "file" || item.type === "directory") && drivePath.type === "trash") {
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

	if ((item.type === "file" || item.type === "directory") && drivePath.type === "trash") {
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

				if (item.type === "file" && router.canGoBack()) {
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
		type,
		className,
		isAnchoredToRight,
		onOpenMenu,
		onCloseMenu,
		drivePath,
		isStoredOffline,
		disabled,
		style
	}: {
		item: DriveItem
		children: React.ReactNode
		type: React.ComponentPropsWithoutRef<typeof MenuComponent>["type"]
		className?: string
		isAnchoredToRight?: boolean
		onOpenMenu?: () => void
		onCloseMenu?: () => void
		drivePath: DrivePath
		isStoredOffline: boolean
		disabled?: boolean
		style?: StyleProp<ViewStyle>
	}) => {
		const menuButtons = disabled
			? []
			: createMenuButtons({
					item,
					drivePath,
					isStoredOffline
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
