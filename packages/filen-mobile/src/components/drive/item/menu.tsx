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
import { newTmpDir } from "@/lib/tmp"
import { Platform, type StyleProp, type ViewStyle } from "react-native"
import * as MediaLibrary from "expo-media-library"
import { hasAllNeededMediaPermissions } from "@/hooks/useMediaPermissions"
import offline from "@/lib/offline"
import { getPreviewType, listLocalDirectoryRecursive, normalizeFilePathForBlobUtil, getRealDriveItemParent } from "@/lib/utils"
import * as ReactNativeBlobUtil from "react-native-blob-util"
import mimeTypes from "mime-types"
import * as Sharing from "expo-sharing"
import type { DrivePath, SelectOptions } from "@/hooks/useDrivePath"
import { serialize } from "@/lib/serializer"
import auth from "@/lib/auth"
import { selectContacts } from "@/routes/contacts"
import cache from "@/lib/cache"
import { selectDriveItems } from "@/routes/driveSelect/[uuid]"
import useDriveStore from "@/stores/useDrive.store"
import { useTranslation } from "react-i18next"
import { type TFunction } from "i18next"

export function createMenuButtons({
	item,
	drivePath,
	isStoredOffline,
	showSelectToggle,
	t
}: {
	item: DriveItem
	drivePath: DrivePath
	isStoredOffline: boolean
	showSelectToggle?: boolean
	t: TFunction
}): MenuButton[] {
	// Undecryptable items only support destructive disposition — every other
	// action (rename/move/share/download/info/etc.) requires decrypted meta.
	// In trash view we surface Restore + Delete-permanently so the user can
	// still recover or purge. Everywhere else, only Trash is available.
	if (item.data.undecryptable) {
		const undecryptableButtons: MenuButton[] = []

		if (drivePath.type === "trash") {
			if (item.type === "file" || item.type === "directory") {
				undecryptableButtons.push({
					id: "restore",
					requiresOnline: true,
					title: t("restore"),
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

				undecryptableButtons.push({
					id: "deletePermanently",
					requiresOnline: true,
					title: t("delete_permanently"),
					icon: "delete",
					destructive: true,
					onPress: async () => {
						const promptResult = await run(async () => {
							return await prompts.alert({
								title: t("delete_permanently_item"),
								message: t("confirm_delete_permanently"),
								cancelText: t("cancel"),
								okText: t("delete_permanently"),
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

			return undecryptableButtons
		}

		// Normal / recents / favorites / sharedIn / sharedOut / links / offline /
		// linked surfaces — Trash is the only path forward.
		if (drivePath.type !== "sharedIn" && drivePath.type !== "offline" && drivePath.type !== "linked") {
			undecryptableButtons.push({
				id: "trash",
				requiresOnline: true,
				title: t("trash"),
				icon: "trash",
				destructive: true,
				onPress: async () => {
					const promptResult = await run(async () => {
						return await prompts.alert({
							title: t("trash_item"),
							message: t("confirm_trash"),
							cancelText: t("cancel"),
							okText: t("trash"),
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
						await drive.trash({
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

		return undecryptableButtons
	}

	const menuButtons: MenuButton[] = []
	const previewType =
		item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile"
			? getPreviewType(item.data.decryptedMeta?.name ?? "")
			: null

	const parentForOfflineStorage = getRealDriveItemParent({
		item,
		drivePath
	})

	const isOwner = !(drivePath.type === "sharedIn")

	// Bulk-selection entry: the row's Menu owns iOS long-press (contextmenu),
	// so we can't add an onLongPress to the inner Pressable. The Menu's
	// "Select" item is the entry point — matches the pattern in notes / chats
	// / file versions / contacts. Suppress in picker mode (driveSelect uses a
	// different store) and when the caller explicitly opts out (drive preview).
	if (showSelectToggle !== false && !drivePath.selectOptions) {
		const isSelected = useDriveStore.getState().selectedItems.some(i => i.data.uuid === item.data.uuid)

		menuButtons.push({
			id: isSelected ? "deselect" : "select",
			title: isSelected ? t("deselect") : t("select"),
			icon: "select",
			checked: isSelected,
			onPress: () => {
				useDriveStore.getState().toggleSelectedItem(item)
			}
		})
	}

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
			title: t("open"),
			icon: "folder",
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
			title: t("download_to_device"),
			icon: "download",
			requiresOnline: true,
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
								? new FileSystem.File(FileSystem.Paths.join(newTmpDir().uri, item.data.decryptedMeta.name))
								: new FileSystem.Directory(FileSystem.Paths.join(newTmpDir().uri, item.data.decryptedMeta.name))
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

					const result = await transfers.download({
						item,
						destination
					})

					if (!result) {
						return
					}

					if (Platform.OS === "android") {
						if (
							(item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile") &&
							destination instanceof FileSystem.File
						) {
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

									// `entry.name` (already decoded by expo's Paths.basename) and the decrypted
									// plaintext name are passed raw — decoding them again threw URIError on
									// names with a bare "%" (e.g. "50% off.jpg"). The parentFolder segments
									// are different: FileSystem.Paths.join re-encodes them (" " -> "%20",
									// "%" -> "%25"), so they must be decoded back, otherwise files land in
									// literally mis-named directories ("Sub%20Folder"). The per-segment decode
									// is guarded so a malformed sequence falls back to the raw segment.
									const parentFolder = FileSystem.Paths.join(
										"Filen",
										item.data.decryptedMeta?.name ?? item.data.uuid,
										FileSystem.Paths.dirname(normalizedEntryPath.slice(destinationUriNormalized.length))
									)
										.split("/")
										.map(segment => {
											if (segment.length === 0) {
												return segment
											}

											try {
												return decodeURIComponent(segment)
											} catch {
												return segment
											}
										})
										.join("/")

									await ReactNativeBlobUtil.default.MediaCollection.copyToMediaStore(
										{
											name: entry.name,
											parentFolder: parentFolder.startsWith("/") ? parentFolder.slice(1) : parentFolder,
											mimeType: mimeTypes.lookup(entry.name) || "application/octet-stream"
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
			requiresOnline: true,
			title: t("make_available_offline"),
			icon: "archive",
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
			requiresOnline: true,
			title: t("save_to_photos"),
			icon: "image",
			onPress: async () => {
				const permissionsResult = await run(async () => {
					return await hasAllNeededMediaPermissions({
						shouldRequest: true
					})
				})

				if (!permissionsResult.success) {
					console.error(permissionsResult.error)
					alerts.error(permissionsResult.error)

					return
				}

				if (!permissionsResult.data) {
					alerts.error(t("no_permissions_enable_manually"))

					return
				}

				const result = await runWithLoading(async defer => {
					if (!item.data.decryptedMeta) {
						throw new Error("Missing decrypted metadata")
					}

					const destination = new FileSystem.File(FileSystem.Paths.join(newTmpDir().uri, item.data.decryptedMeta.name))

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

					const result = await transfers.download({
						item,
						destination
					})

					if (!result) {
						return
					}

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
			requiresOnline: true,
			title: t("export"),
			icon: "export",
			onPress: async () => {
				const result = await runWithLoading(async () => {
					if (!item.data.decryptedMeta) {
						throw new Error("Missing decrypted metadata")
					}

					const destination = new FileSystem.File(FileSystem.Paths.join(newTmpDir().uri, item.data.decryptedMeta.name))

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
						destination
					})

					if (!downloadResult) {
						return null
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
					if (!result.data) {
						return
					}

					defer(() => {
						if (result.data && result.data.parentDirectory.exists) {
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
		(item.type === "file" ||
			item.type === "directory" ||
			item.type === "sharedFile" ||
			item.type === "sharedRootFile" ||
			item.type === "sharedDirectory" ||
			item.type === "sharedRootDirectory") &&
		item.data.decryptedMeta &&
		(!isOwner || drivePath.type === "linked")
	) {
		downloadSubButtons.push({
			id: "import",
			requiresOnline: true,
			title: t("import"),
			icon: "import",
			onPress: async () => {
				const selectResult = await run(async () => {
					return await selectDriveItems({
						type: "single",
						files: false,
						directories: true,
						items: []
					})
				})

				if (!selectResult.success) {
					console.error(selectResult.error)
					alerts.error(selectResult.error)

					return
				}

				if (selectResult.data.cancelled) {
					return
				}

				const selectedItem = selectResult.data.selectedItems[0]

				if (!selectedItem) {
					return
				}

				const remoteDir = (() => {
					if (selectedItem.type === "root") {
						return selectedItem.data
					}

					const fromCache = cache.directoryUuidToAnyNormalDir.get(selectedItem.data.data.uuid)

					if (!fromCache) {
						return null
					}

					return fromCache
				})()

				if (!remoteDir) {
					return
				}

				const result = await run(async defer => {
					if (!item.data.decryptedMeta) {
						throw new Error("Missing decrypted metadata")
					}

					const destination =
						item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile"
							? new FileSystem.File(FileSystem.Paths.join(newTmpDir().uri, item.data.decryptedMeta.name))
							: new FileSystem.Directory(FileSystem.Paths.join(newTmpDir().uri, item.data.decryptedMeta.name))

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

					const downloadResult = await transfers.download({
						item,
						destination
					})

					if (!downloadResult) {
						return
					}

					const uploadResult = await transfers.upload({
						localFileOrDir: destination,
						parent: remoteDir,
						name: item.data.decryptedMeta.name,
						created:
							(item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile") &&
							item.data.decryptedMeta.created
								? Number(item.data.decryptedMeta.created)
								: undefined,
						modified:
							(item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile") &&
							item.data.decryptedMeta.modified
								? Number(item.data.decryptedMeta.modified)
								: undefined,
						mime:
							(item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile") &&
							item.data.decryptedMeta.mime
								? item.data.decryptedMeta.mime
								: undefined
					})

					if (!uploadResult) {
						return
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

	// download + share moved further down (after rename/move) so the menu
	// reads: meta (favorite/info/versions/color) → modify (rename/move) →
	// output (download/share) → destructive. Matches iOS Files conventions.

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
			requiresOnline: true,
			title: item.data.favorited ? t("unfavorite") : t("favorite"),
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
			title: t("info"),
			icon: "info",
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
				title: t("versions"),
				icon: "versions",
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
			title: t("color"),
			icon: "color",
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
			requiresOnline: true,
			title: t("rename"),
			icon: "edit",
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.input({
						title: t("rename_item"),
						message: t("enter_new_name"),
						defaultValue: item.data.decryptedMeta?.name ?? "",
						cancelText: t("cancel"),
						okText: t("rename")
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
				requiresOnline: true,
				title: t("move"),
				icon: "move",
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

	if (
		downloadSubButtons.length > 0 &&
		drivePath.type !== "offline" &&
		(item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile"
			? (item.data.decryptedMeta?.size ?? 0) > 0
			: true)
	) {
		menuButtons.push({
			id: "download",
			title: t("download"),
			icon: "download",
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
			title: t("share"),
			icon: "share",
			subButtons: [
				{
					id: "sharePublicLink",
					requiresOnline: true,
					title: t("share_public_link"),
					icon: "link",
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
					requiresOnline: true,
					title: t("share_filen_user"),
					icon: "users",
					onPress: async () => {
						const pickResult = await run(async () => {
							return await selectContacts({
								multiple: true,
								userIdsToExclude: []
							})
						})

						if (!pickResult.success) {
							console.error(pickResult.error)
							alerts.error(pickResult.error)

							return
						}

						if (pickResult.data.cancelled || pickResult.data.selectedContacts.length === 0) {
							return
						}

						const contacts = pickResult.data.selectedContacts

						const result = await runWithLoading(async () => {
							await Promise.all(contacts.map(contact => drive.shareWithFilenUser({ item, contact })))
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)
						}
					}
				}
			]
		})
	}

	// Removing offline only makes sense on items that are TOP-LEVEL stored entries.
	// `updateIndex()` flattens every nested child of a stored directory into
	// `index.files` / `index.directories`, so a plain "is stored offline" check
	// (the query backing `isStoredOffline`) returns true for nested children too —
	// but `removeItem` only operates on top-level entries, so showing the button
	// there is a silent no-op. The sync top-level check fixes that. Cold-cache
	// falls back to undefined → hidden, which is acceptable: the per-row query
	// (`useDriveItemStoredOfflineQuery`) warms the caches on first read.
	//
	//   - At /offline (virtual root) we know every item shown IS top-level, so
	//     skip the per-item check.
	//   - Anywhere else (/drive, /favorites, etc.), only show on items that are
	//     known top-level stored. /offline nested view and /linked never show.
	if (
		(drivePath.type === "offline" && !drivePath.uuid) ||
		(offline.isItemTopLevelStoredSync(item) === true &&
			drivePath.type !== "offline" &&
			drivePath.type !== "linked")
	) {
		menuButtons.push({
			id: "removeOffline",
			title: t("remove_offline"),
			icon: "trash",
			destructive: true,
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.alert({
						title: t("remove_offline_item"),
						message: t("confirm_remove_offline"),
						cancelText: t("cancel"),
						okText: t("remove_offline"),
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

	if (drivePath.type === "sharedIn" && !drivePath.uuid) {
		menuButtons.push({
			id: "removeShare",
			requiresOnline: true,
			title: t("remove_share"),
			icon: "delete",
			destructive: true,
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.alert({
						title: t("remove_share_item"),
						message: t("confirm_remove_share"),
						cancelText: t("cancel"),
						okText: t("remove_share"),
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

	if (drivePath.type === "sharedOut" && !drivePath.uuid) {
		menuButtons.push({
			id: "stopSharing",
			requiresOnline: true,
			title: t("stop_sharing"),
			icon: "delete",
			destructive: true,
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.alert({
						title: t("stop_sharing_item"),
						message: t("confirm_stop_sharing"),
						cancelText: t("cancel"),
						okText: t("stop_sharing"),
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
			requiresOnline: true,
			title: t("disable_public_link"),
			icon: "delete",
			destructive: true,
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.alert({
						title: t("disable_public_link"),
						message: t("confirm_disable_public_link"),
						cancelText: t("cancel"),
						okText: t("disable"),
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
		drivePath.type !== "linked"
	) {
		menuButtons.push({
			id: "trash",
			requiresOnline: true,
			title: t("trash"),
			icon: "trash",
			destructive: true,
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.alert({
						title: t("trash_item"),
						message: t("confirm_trash"),
						cancelText: t("cancel"),
						okText: t("trash")
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
			requiresOnline: true,
			title: t("restore"),
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
			requiresOnline: true,
			title: t("delete_permanently"),
			icon: "delete",
			destructive: true,
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.alert({
						title: t("delete_permanently_item"),
						message: t("confirm_delete_permanently"),
						cancelText: t("cancel"),
						okText: t("delete_permanently"),
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
		style,
		showSelectToggle
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
		showSelectToggle?: boolean
	}) => {
		const { t } = useTranslation()
		const menuButtons = disabled
			? []
			: createMenuButtons({
					item,
					drivePath,
					isStoredOffline,
					showSelectToggle,
					t
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
