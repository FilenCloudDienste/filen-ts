import { Fragment, useState, useEffect, memo, useCallback } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import StackHeader, { type HeaderItem } from "@/components/ui/header"
import useDrivePath, { type SelectOptions } from "@/hooks/useDrivePath"
import useDriveItemsQuery from "@/queries/useDriveItems.query"
import type { DriveItem } from "@/types"
import { itemSorter, type SortByType } from "@/lib/sort"
import { useDriveSortPreference } from "@/lib/driveSortPreference"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
import ListEmpty from "@/components/ui/listEmpty"
import Item from "@/components/drive/item"
import { run, cn } from "@filen/utils"
import alerts from "@/lib/alerts"
import { Platform } from "react-native"
import { useResolveClassNames } from "uniwind"
import { router, useFocusEffect } from "expo-router"
import prompts from "@/lib/prompts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import drive from "@/lib/drive"
import useDriveStore from "@/stores/useDrive.store"
import { useShallow } from "zustand/shallow"
import type { MenuButton } from "@/components/ui/menu"
import auth, { useStringifiedClient } from "@/lib/auth"
import cache from "@/lib/cache"
import { AnyNormalDir } from "@filen/sdk-rs"
import { debounce } from "es-toolkit/function"
import * as ImagePicker from "expo-image-picker"
import transfers from "@/lib/transfers"
import * as FileSystem from "expo-file-system"
import { randomUUID } from "expo-crypto"
import { newTmpDir } from "@/lib/tmp"
import { unwrapFileMeta, unwrappedFileIntoDriveItem, normalizeFilePathForExpo, getRealDriveItemParent } from "@/lib/utils"
import offline from "@/lib/offline"
import DocumentScanner, {
	ResponseType as DocumentScannerResponseType,
	ScanDocumentResponseStatus
} from "react-native-document-scanner-plugin"
import * as DocumentPicker from "expo-document-picker"
import { hasAllNeededMediaPermissions } from "@/hooks/useMediaPermissions"
import * as MediaLibrary from "expo-media-library"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"
import useOfflineStore from "@/stores/useOffline.store"
import { onlineManager } from "@tanstack/react-query"
import { runBulk } from "@/lib/bulkOps"
import { aggregateDriveSelectionFlags } from "@/lib/driveSelectors"
import { downloadDriveItemToDevice } from "@/lib/driveDownload"
import { serialize } from "@/lib/serializer"
import { selectContacts } from "@/routes/contacts"
import { driveItemDisplayName } from "@/lib/decryption"

function buildSortMenuButton(current: SortByType, setSort: (next: SortByType) => void): MenuButton {
	const leaf = (id: string, title: string, value: SortByType): MenuButton => ({
		id,
		title,
		checked: current === value,
		onPress: () => setSort(value)
	})

	return {
		id: "sort",
		title: "tbd_sort_by",
		icon: "list",
		subButtons: [
			{
				id: "sort.name",
				title: "tbd_sort_name",
				icon: "text",
				subButtons: [leaf("sort.nameAsc", "tbd_sort_name_asc", "nameAsc"), leaf("sort.nameDesc", "tbd_sort_name_desc", "nameDesc")]
			},
			{
				id: "sort.size",
				title: "tbd_sort_size",
				icon: "size",
				subButtons: [leaf("sort.sizeAsc", "tbd_sort_size_asc", "sizeAsc"), leaf("sort.sizeDesc", "tbd_sort_size_desc", "sizeDesc")]
			},
			{
				id: "sort.type",
				title: "tbd_sort_type",
				icon: "doc",
				subButtons: [leaf("sort.mimeAsc", "tbd_sort_type_asc", "mimeAsc"), leaf("sort.mimeDesc", "tbd_sort_type_desc", "mimeDesc")]
			},
			{
				id: "sort.modified",
				title: "tbd_sort_modified",
				icon: "clock",
				subButtons: [
					leaf("sort.lastModifiedAsc", "tbd_sort_modified_asc", "lastModifiedAsc"),
					leaf("sort.lastModifiedDesc", "tbd_sort_modified_desc", "lastModifiedDesc")
				]
			},
			{
				id: "sort.uploaded",
				title: "tbd_sort_uploaded",
				icon: "upload",
				subButtons: [
					leaf("sort.uploadDateAsc", "tbd_sort_uploaded_asc", "uploadDateAsc"),
					leaf("sort.uploadDateDesc", "tbd_sort_uploaded_desc", "uploadDateDesc")
				]
			},
			{
				id: "sort.created",
				title: "tbd_sort_created",
				icon: "calendar",
				subButtons: [
					leaf("sort.creationAsc", "tbd_sort_created_asc", "creationAsc"),
					leaf("sort.creationDesc", "tbd_sort_created_desc", "creationDesc")
				]
			}
		]
	}
}

const Header = memo(({ setSearchQuery }: { setSearchQuery: React.Dispatch<React.SetStateAction<string>> }) => {
	const textForeground = useResolveClassNames("text-foreground")
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const selectedDriveItems = useDriveStore(useShallow(state => state.selectedItems))
	const drivePath = useDrivePath()
	const stringifiedClient = useStringifiedClient()
	const offlineSyncing = useOfflineStore(state => state.syncing)
	const { sort: currentSort, setSort, sortable } = useDriveSortPreference(drivePath)

	const driveItemsQuery = useDriveItemsQuery(
		{
			path: drivePath
		},
		{
			enabled: false
		}
	)

	const driveItems = driveItemsQuery.status === "success" ? driveItemsQuery.data : []

	const parent: AnyNormalDir | null = (() => {
		// If we're at the root of the drive and we have the root uuid in cache, we can return a AnyNormalDir for the root directory
		if (drivePath.type === "drive" && drivePath.uuid === null && cache.rootUuid) {
			return new AnyNormalDir.Root({
				uuid: cache.rootUuid
			})
		}

		// We can check if the parent uuid of the current drive path is in the anyNormalDir cache
		// If it is, it's a directory that belongs to the user (not shared in)
		const fromCache = cache.directoryUuidToAnyNormalDir.get(drivePath.uuid ?? "")

		return fromCache ?? null
	})()

	const rightItems = (() => {
		if (drivePath.selectOptions) {
			return []
		}

		const selectionMode = selectedDriveItems.length > 0
		const items: HeaderItem[] = []
		const menuButtons: MenuButton[] = []

		if (sortable && !selectionMode) {
			menuButtons.push(buildSortMenuButton(currentSort, setSort))
		}

		if (driveItems.length > 0) {
			if (selectedDriveItems.length === driveItems.length) {
				menuButtons.push({
					id: "deselectAll",
					title: "tbd_deselect_all",
					icon: "select",
					onPress: () => {
						useDriveStore.getState().clearSelectedItems()
					}
				})
			} else {
				menuButtons.push({
					id: "selectAll",
					title: "tbd_select_all",
					icon: "select",
					onPress: () => {
						useDriveStore.getState().selectAllItems(driveItems)
					}
				})
			}
		}

		if (
			parent &&
			(drivePath.type === "drive" ||
				drivePath.type === "links" ||
				drivePath.type === "favorites" ||
				(drivePath.type === "sharedOut" && drivePath.uuid)) &&
			!drivePath.selectOptions &&
			!selectionMode
		) {
			menuButtons.push({
				id: "createFolder",
				title: "tbd_create_folder",
				icon: "plus",
				requiresOnline: true,
				onPress: async () => {
					const promptResult = await run(async () => {
						return await prompts.input({
							title: "tbd_create_folder",
							message: "tbd_enter_folder_name",
							cancelText: "tbd_cancel",
							okText: "tbd_create",
							placeholder: "tbd_folder_name"
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

					const folderName = promptResult.data.value.trim()

					if (folderName.length === 0) {
						return
					}

					const result = await runWithLoading(async () => {
						await drive.createDirectory({
							name: folderName,
							parent
						})
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)
					}
				}
			})

			menuButtons.push({
				id: "upload",
				title: "tbd_upload",
				icon: "upload",
				subButtons: [
					{
						id: "uploadFiles",
						title: "tbd_upload_files",
						icon: "upload",
						requiresOnline: true,
						onPress: async () => {
							const documentPickerResult = await run(async () => {
								return await DocumentPicker.getDocumentAsync({
									type: "*/*",
									multiple: true,
									copyToCacheDirectory: true,
									base64: false
								})
							})

							if (!documentPickerResult.success) {
								console.error(documentPickerResult.error)
								alerts.error(documentPickerResult.error)

								return
							}

							if (documentPickerResult.data.canceled) {
								return
							}

							const assets = documentPickerResult.data.assets

							const transferResult = await run(async () => {
								return await Promise.allSettled(
									assets.map(async asset => {
										return await run(
											async defer => {
												const assetFile = new FileSystem.File(asset.uri)

												defer(() => {
													if (assetFile.exists) {
														assetFile.delete()
													}
												})

												if (!assetFile.exists) {
													throw new Error("Asset file does not exist")
												}

												return await transfers.upload({
													localFileOrDir: assetFile,
													parent,
													name: asset.name,
													modified: asset.lastModified,
													mime: asset.mimeType
												})
											},
											{
												throw: true
											}
										)
									})
								)
							})

							if (!transferResult.success) {
								console.error(transferResult.error)
								alerts.error(transferResult.error)

								return
							}

							for (const r of transferResult.data) {
								if (r.status === "rejected") {
									console.error(r.reason)
									alerts.error(r.reason)
								} else if (!r.value.success) {
									console.error(r.value.error)
									alerts.error(r.value.error)
								}
							}

							// TODO: display toast on upload success with number of successfully uploaded files and number of failed uploads
						}
					},
					{
						id: "uploadPhotosOrVideos",
						requiresOnline: true,
						title: "tbd_upload_photos_or_videos",
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
								alerts.error("tbd_no_permissions_enable_manually")

								return
							}

							const imagePickerResult = await run(async () => {
								return await ImagePicker.launchImageLibraryAsync({
									mediaTypes: ["images", "videos"],
									exif: false,
									base64: false,
									quality: 1,
									allowsMultipleSelection: true,
									presentationStyle: ImagePicker.UIImagePickerPresentationStyle.PAGE_SHEET,
									shouldDownloadFromNetwork: true
								})
							})

							if (!imagePickerResult.success) {
								console.error(imagePickerResult.error)
								alerts.error(imagePickerResult.error)

								return
							}

							if (imagePickerResult.data.canceled) {
								return
							}

							const assets = imagePickerResult.data.assets

							const transferResult = await run(async () => {
								return await Promise.allSettled(
									assets.map(async asset => {
										return await run(
											async defer => {
												const assetFile = new FileSystem.File(asset.uri)

												defer(() => {
													if (assetFile.exists) {
														assetFile.delete()
													}
												})

												if (!assetFile.exists) {
													throw new Error("Asset file does not exist")
												}

												const extname = FileSystem.Paths.extname(asset.uri)
												const fileName = asset.fileName ?? `${randomUUID()}${extname}`

												return await transfers.upload({
													localFileOrDir: assetFile,
													parent,
													name: fileName,
													mime: asset.mimeType
												})
											},
											{
												throw: true
											}
										)
									})
								)
							})

							if (!transferResult.success) {
								console.error(transferResult.error)
								alerts.error(transferResult.error)

								return
							}

							for (const r of transferResult.data) {
								if (r.status === "rejected") {
									console.error(r.reason)
									alerts.error(r.reason)
								} else if (!r.value.success) {
									console.error(r.value.error)
									alerts.error(r.value.error)
								}
							}

							// TODO: display toast on upload success with number of successfully uploaded files and number of failed uploads
						}
					},
					{
						id: "takePhotoOrVideo",
						title: "tbd_take_photo_or_video",
						icon: "camera",
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
								alerts.error("tbd_no_permissions_enable_manually")

								return
							}

							const imagePickerResult = await run(async () => {
								return await ImagePicker.launchCameraAsync({
									mediaTypes: ["images", "videos"],
									exif: false,
									base64: false,
									quality: 1,
									allowsMultipleSelection: true,
									presentationStyle: ImagePicker.UIImagePickerPresentationStyle.PAGE_SHEET,
									shouldDownloadFromNetwork: true
								})
							})

							if (!imagePickerResult.success) {
								console.error(imagePickerResult.error)
								alerts.error(imagePickerResult.error)

								return
							}

							if (imagePickerResult.data.canceled) {
								return
							}

							const assets = imagePickerResult.data.assets

							const transferResult = await run(async () => {
								return await Promise.allSettled(
									assets.map(async asset => {
										return await run(
											async defer => {
												const assetFile = new FileSystem.File(asset.uri)

												defer(() => {
													if (assetFile.exists) {
														assetFile.delete()
													}
												})

												if (!assetFile.exists) {
													throw new Error("Asset file does not exist")
												}

												const extname = FileSystem.Paths.extname(asset.uri)
												const fileName = asset.fileName ?? `${randomUUID()}${extname}`

												return await transfers.upload({
													localFileOrDir: assetFile,
													parent,
													name: fileName,
													mime: asset.mimeType,
													modified: Date.now(),
													created: Date.now()
												})
											},
											{
												throw: true
											}
										)
									})
								)
							})

							if (!transferResult.success) {
								console.error(transferResult.error)
								alerts.error(transferResult.error)

								return
							}

							for (const r of transferResult.data) {
								if (r.status === "rejected") {
									console.error(r.reason)
									alerts.error(r.reason)
								} else if (!r.value.success) {
									console.error(r.value.error)
									alerts.error(r.value.error)
								}
							}

							// TODO: display toast on upload success with number of successfully uploaded files and number of failed uploads
						}
					},
					{
						id: "scanDocument",
						requiresOnline: true,
						title: "tbd_scan_document",
						icon: "scan",
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
								alerts.error("tbd_no_permissions_enable_manually")

								return
							}

							const scannerResult = await run(async () => {
								return await DocumentScanner.scanDocument({
									maxNumDocuments: undefined,
									croppedImageQuality: 100,
									responseType: DocumentScannerResponseType.ImageFilePath
								})
							})

							if (!scannerResult.success) {
								console.error(scannerResult.error)
								alerts.error(scannerResult.error)

								return
							}

							if (scannerResult.data.status !== ScanDocumentResponseStatus.Success) {
								return
							}

							const scans = scannerResult.data.scannedImages

							if (!scans || scans.length === 0) {
								return
							}

							const transferResult = await run(async () => {
								return await Promise.allSettled(
									scans.map(async scan => {
										return await run(
											async defer => {
												const scanFile = new FileSystem.File(normalizeFilePathForExpo(scan))

												defer(() => {
													if (scanFile.exists) {
														scanFile.delete()
													}
												})

												return await transfers.upload({
													localFileOrDir: scanFile,
													parent,
													modified: Date.now(),
													created: Date.now(),
													name: `tbd_scanned_document_${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`,
													mime: "image/jpeg"
												})
											},
											{
												throw: true
											}
										)
									})
								)
							})

							if (!transferResult.success) {
								console.error(transferResult.error)
								alerts.error(transferResult.error)

								return
							}

							for (const r of transferResult.data) {
								if (r.status === "rejected") {
									console.error(r.reason)
									alerts.error(r.reason)
								} else if (!r.value.success) {
									console.error(r.value.error)
									alerts.error(r.value.error)
								}
							}

							// TODO: display toast on upload success with number of successfully uploaded files and number of failed uploads
						}
					},
					{
						id: "createTextFile",
						title: "tbd_create_text_file",
						icon: "text",
						onPress: async () => {
							const promptResult = await run(async () => {
								return await prompts.input({
									title: "tbd_create_text_file",
									message: "tbd_enter_text_file_name",
									cancelText: "tbd_cancel",
									okText: "tbd_create",
									placeholder: "tbd_text_file_name"
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

							let fileName = promptResult.data.value.trim()

							if (fileName.length === 0) {
								return
							}

							const extname = FileSystem.Paths.extname(fileName)

							if (extname.length === 0) {
								fileName += ".txt"
							}

							const result = await runWithLoading(async defer => {
								const tmpDir = newTmpDir()
								const tmpFile = new FileSystem.File(FileSystem.Paths.join(tmpDir.uri, fileName))

								defer(() => {
									if (tmpDir.exists) {
										tmpDir.delete()
									}
								})

								if (!tmpDir.exists) {
									tmpDir.create({
										idempotent: true,
										intermediates: true
									})
								}

								if (tmpFile.exists) {
									tmpFile.delete()
								}

								tmpFile.write("", {
									encoding: "utf8"
								})

								return await transfers.upload({
									localFileOrDir: tmpFile,
									parent,
									name: fileName,
									mime: "text/plain",
									modified: Date.now(),
									created: Date.now()
								})
							})

							if (!result.success) {
								console.error(result.error)
								alerts.error(result.error)

								return
							}

							if (!result.data) {
								return
							}

							const file = result.data.files.at(0)

							if (!file) {
								return
							}

							const item = unwrappedFileIntoDriveItem(unwrapFileMeta(file))

							if (item.type !== "file" && item.type !== "sharedFile" && item.type !== "sharedRootFile") {
								return
							}

							useDrivePreviewStore.getState().open({
								initialItem: {
									type: "drive",
									data: {
										item: item,
										drivePath
									}
								},
								items: [
									{
										type: "drive",
										data: item
									}
								]
							})
						}
					}
				]
			})
		}

		if (!selectionMode) {
			menuButtons.push({
				id: "transfers",
				title: "tbd_transfers",
				icon: "list",
				onPress: () => {
					router.push("/transfers")
				}
			})

			// Manual offline-cache sync trigger. Auto-sync runs on every offline→online
			// transition (reconnect.ts), but the offline tab is where users go when they
			// expect their cached set to be current — surface a way to nudge it.
			if (drivePath.type === "offline") {
				menuButtons.push({
					id: "syncNow",
					title: offlineSyncing ? "tbd_syncing" : "tbd_sync_now",
					icon: "restore",
					disabled: offlineSyncing,
					onPress: () => {
						offline.sync().catch(console.error)
					}
				})
			}
		}

		if (selectedDriveItems.length > 0) {
			// Cross-reference selected items with the live query list before
			// aggregating flags. Otherwise stale selection entries (e.g. an item
			// that became undecryptable after a key change, or whose favorited
			// state flipped via socket event) would feed outdated booleans into
			// the bulk toolbar.
			const liveItems = selectedDriveItems.map(sel => driveItems.find(live => live.data.uuid === sel.data.uuid) ?? sel)
			const driveFlags = aggregateDriveSelectionFlags(liveItems)
			const isAtRoot = !drivePath.uuid

			if (drivePath.type === "trash") {
				menuButtons.push({
					id: "restoreSelected",
					title: "tbd_restore_selected",
					icon: "restore",
					requiresOnline: true,
					onPress: async () => {
						await runBulk({
							items: selectedDriveItems,
							clearSelection: () => useDriveStore.getState().clearSelectedItems(),
							confirm: {
								title: "tbd_restore_selected",
								message: "tbd_are_you_sure_restore_selected",
								okText: "tbd_restore",
								cancelText: "tbd_cancel"
							},
							op: item => drive.restore({ item, signal: undefined })
						})
					}
				})

				menuButtons.push({
					id: "deleteSelectedPermanently",
					title: "tbd_delete_selected_permanently",
					destructive: true,
					icon: "delete",
					requiresOnline: true,
					onPress: async () => {
						await runBulk({
							items: selectedDriveItems,
							clearSelection: () => useDriveStore.getState().clearSelectedItems(),
							confirm: {
								title: "tbd_delete_selected_permanently",
								message: "tbd_are_you_sure_delete_selected_permanently",
								okText: "tbd_delete",
								cancelText: "tbd_cancel",
								destructive: true
							},
							op: item => drive.deletePermanently({ item, signal: undefined })
						})
					}
				})
			} else {
				// Favorite/Unfavorite first — toggle is the most-tapped bulk
				// action, belongs at the top of the menu.
				if (
					drivePath.type === "drive" ||
					drivePath.type === "recents" ||
					drivePath.type === "favorites" ||
					drivePath.type === "sharedOut"
				) {
					menuButtons.push({
						id: "bulkFavorite",
						title: driveFlags.includesFavorited ? "tbd_unfavorite_selected" : "tbd_favorite_selected",
						icon: "heart",
						requiresOnline: true,
						onPress: async () => {
							await runBulk({
								items: selectedDriveItems,
								clearSelection: () => useDriveStore.getState().clearSelectedItems(),
								op: item =>
									drive.favorite({
										item,
										favorited: !driveFlags.includesFavorited,
										signal: undefined
									})
							})
						}
					})
				}

				// Move — modify (location) comes before output (download/share).
				// driveSelectToolbar already handles `Promise.all` over the items
				// it receives, so the bulk handler just opens the picker with all
				// selected items. useFocusEffect on Drive clears selection when
				// we return.
				if (
					drivePath.type === "drive" ||
					drivePath.type === "favorites" ||
					drivePath.type === "sharedOut" ||
					drivePath.type === "links" ||
					drivePath.type === "recents"
				) {
					menuButtons.push({
						id: "bulkMove",
						title: "tbd_move_selected",
						icon: "move",
						requiresOnline: true,
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
										items: selectedDriveItems,
										id: randomUUID()
									} satisfies SelectOptions)
								}
							})
						}
					})
				}

				// Download to device — applies to every read-capable variant.
				if (
					drivePath.type === "drive" ||
					drivePath.type === "recents" ||
					drivePath.type === "favorites" ||
					drivePath.type === "sharedIn" ||
					drivePath.type === "sharedOut" ||
					drivePath.type === "links"
				) {
					menuButtons.push({
						id: "bulkDownload",
						title: "tbd_download_selected",
						icon: "download",
						requiresOnline: true,
						onPress: async () => {
							await runBulk({
								items: selectedDriveItems,
								clearSelection: () => useDriveStore.getState().clearSelectedItems(),
								op: async item => {
									const result = await downloadDriveItemToDevice({ item })

									if (!result.success) {
										throw result.error
									}
								}
							})
						}
					})
				}

				// Save to photos — every selected item must be a file with an
				// image/video preview type (the OS photo library only accepts
				// those). Aggregator flag is computed once via getPreviewType
				// over decryptedMeta.name.
				if (
					driveFlags.everyImageOrVideoFile &&
					(drivePath.type === "drive" || drivePath.type === "recents" || drivePath.type === "favorites")
				) {
					menuButtons.push({
						id: "bulkSaveToPhotos",
						title: "tbd_save_to_photos_selected",
						icon: "image",
						requiresOnline: true,
						onPress: async () => {
							const permissionsResult = await run(async () => {
								return await hasAllNeededMediaPermissions({ shouldRequest: true })
							})

							if (!permissionsResult.success) {
								console.error(permissionsResult.error)
								alerts.error(permissionsResult.error)

								return
							}

							if (!permissionsResult.data) {
								alerts.error("tbd_no_permissions_enable_manually")

								return
							}

							await runBulk({
								items: selectedDriveItems,
								clearSelection: () => useDriveStore.getState().clearSelectedItems(),
								op: async item => {
									if (!item.data.decryptedMeta) {
										return
									}

									await run(async defer => {
										const destination = new FileSystem.File(
											FileSystem.Paths.join(newTmpDir().uri, item.data.decryptedMeta!.name)
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

										const downloadResult = await transfers.download({ item, destination })

										if (!downloadResult) {
											return
										}

										await MediaLibrary.saveToLibraryAsync(destination.uri)
									})
								}
							})
						}
					})
				}

				// Share with Filen user — re-encrypts each item under each
				// recipient's public key (SDK shareDir / shareFile). Grouped with
				// the other "output" actions (download / save-to-photos). The
				// picker is the confirmation gesture; no extra confirm dialog.
				if (
					drivePath.type === "drive" ||
					drivePath.type === "recents" ||
					drivePath.type === "favorites" ||
					drivePath.type === "sharedOut"
				) {
					menuButtons.push({
						id: "bulkShareFilenUser",
						title: "tbd_share_filen_user_selected",
						icon: "users",
						requiresOnline: true,
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

							await runBulk({
								items: selectedDriveItems,
								clearSelection: () => useDriveStore.getState().clearSelectedItems(),
								op: async item => {
									await Promise.all(contacts.map(contact => drive.shareWithFilenUser({ item, contact })))
								}
							})
						}
					})
				}

				// Make offline / Remove offline — keep them as two separate buttons
				// instead of a single toggle. Toggling would need per-item offline
				// status (via N useDriveItemStoredOfflineQuery calls or a query
				// helper) and the user's intent for a mixed selection is
				// ambiguous anyway. The lib's idempotent semantics make
				// already-offline / already-online items no-ops, so showing both
				// is safe.
				//
				// Discoverability gate: per-item Make-offline hides when the item is
				// already stored. Mirror that in bulk by hiding bulkMakeOffline when
				// every selected item is known to be stored offline. Falls back to
				// "show" when the per-item cache hasn't been populated yet.
				const everySelectedKnownStoredOffline = liveItems.every(it => offline.isItemStoredSync(it) === true)

				if ((drivePath.type === "drive" || drivePath.type === "favorites") && !everySelectedKnownStoredOffline) {
					menuButtons.push({
						id: "bulkMakeOffline",
						title: "tbd_make_available_offline_selected",
						icon: "archive",
						requiresOnline: true,
						onPress: async () => {
							await runBulk({
								items: selectedDriveItems,
								clearSelection: () => useDriveStore.getState().clearSelectedItems(),
								op: async item => {
									const parent = getRealDriveItemParent({ item, drivePath })

									if (!parent) {
										return
									}

									if (item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile") {
										await offline.storeFile({ file: item, parent })
									} else {
										await offline.storeDirectory({ directory: item, parent })
									}
								}
							})
						}
					})
				}

				// Remove offline — mirror the per-item rule: only show when at least
				// one selected item is a TOP-LEVEL stored offline entry. Nested
				// children of stored directories register as "stored" via the
				// flattened index, but `removeItem` only operates on top-level
				// entries, so showing the button for them would silently no-op.
				//
				//   - /offline (virtual root): everything shown IS top-level by
				//     construction, so no per-item check needed.
				//   - /drive, /favorites: must verify at least one selected item is
				//     a known top-level stored entry. /offline nested + /linked +
				//     other views never show this action.
				const anySelectedTopLevelOffline = liveItems.some(it => offline.isItemTopLevelStoredSync(it) === true)

				if (
					(drivePath.type === "offline" && !drivePath.uuid) ||
					((drivePath.type === "drive" || drivePath.type === "favorites") && anySelectedTopLevelOffline)
				) {
					menuButtons.push({
						id: "bulkRemoveOffline",
						title: "tbd_remove_offline_selected",
						icon: "trash",
						destructive: true,
						onPress: async () => {
							await runBulk({
								items: selectedDriveItems,
								clearSelection: () => useDriveStore.getState().clearSelectedItems(),
								confirm: {
									title: "tbd_remove_offline_selected",
									message: "tbd_confirm_remove_offline_selected",
									okText: "tbd_remove_offline",
									cancelText: "tbd_cancel",
									destructive: true
								},
								op: item => offline.removeItem(item)
							})
						}
					})
				}

				// Trash — owned content the user can move to trash (excludes sharedIn / offline)
				if (
					drivePath.type === "drive" ||
					drivePath.type === "favorites" ||
					drivePath.type === "sharedOut" ||
					drivePath.type === "links" ||
					drivePath.type === "recents"
				) {
					menuButtons.push({
						id: "bulkTrash",
						title: "tbd_trash_selected",
						icon: "trash",
						destructive: true,
						requiresOnline: true,
						onPress: async () => {
							await runBulk({
								items: selectedDriveItems,
								clearSelection: () => useDriveStore.getState().clearSelectedItems(),
								confirm: {
									title: "tbd_trash_selected",
									message: "tbd_are_you_sure_trash_selected",
									okText: "tbd_trash",
									cancelText: "tbd_cancel",
									destructive: true
								},
								op: item => drive.trash({ item, signal: undefined })
							})
						}
					})
				}

				// Stop-sharing — sharedOut at root only
				if (drivePath.type === "sharedOut" && isAtRoot) {
					menuButtons.push({
						id: "bulkStopSharing",
						title: "tbd_stop_sharing_selected",
						icon: "delete",
						destructive: true,
						requiresOnline: true,
						onPress: async () => {
							await runBulk({
								items: selectedDriveItems,
								clearSelection: () => useDriveStore.getState().clearSelectedItems(),
								confirm: {
									title: "tbd_stop_sharing_selected",
									message: "tbd_are_you_sure_stop_sharing_selected",
									okText: "tbd_stop_sharing",
									cancelText: "tbd_cancel",
									destructive: true
								},
								op: item => drive.removeShare({ item, signal: undefined })
							})
						}
					})
				}

				// Remove-share — sharedIn at root only (declines a share invite for selected items)
				if (drivePath.type === "sharedIn" && isAtRoot) {
					menuButtons.push({
						id: "bulkRemoveShare",
						title: "tbd_remove_share_selected",
						icon: "delete",
						destructive: true,
						requiresOnline: true,
						onPress: async () => {
							await runBulk({
								items: selectedDriveItems,
								clearSelection: () => useDriveStore.getState().clearSelectedItems(),
								confirm: {
									title: "tbd_remove_share_selected",
									message: "tbd_are_you_sure_remove_share_selected",
									okText: "tbd_remove",
									cancelText: "tbd_cancel",
									destructive: true
								},
								op: item => drive.removeShare({ item, signal: undefined })
							})
						}
					})
				}

				// Disable public link — links variant root only
				if (drivePath.type === "links" && isAtRoot) {
					menuButtons.push({
						id: "bulkDisablePublicLink",
						title: "tbd_disable_public_link_selected",
						icon: "delete",
						destructive: true,
						requiresOnline: true,
						onPress: async () => {
							await runBulk({
								items: selectedDriveItems,
								clearSelection: () => useDriveStore.getState().clearSelectedItems(),
								confirm: {
									title: "tbd_disable_public_link_selected",
									message: "tbd_are_you_sure_disable_public_link_selected",
									okText: "tbd_disable",
									cancelText: "tbd_cancel",
									destructive: true
								},
								op: item => drive.disablePublicLink({ item, signal: undefined })
							})
						}
					})
				}
			}
		}

		if (drivePath.type === "trash" && !selectionMode) {
			menuButtons.push({
				id: "empty",
				title: "tbd_empty_trash",
				destructive: true,
				icon: "delete",
				onPress: async () => {
					const promptResult = await run(async () => {
						return await prompts.alert({
							title: "tbd_empty_trash",
							message: "tbd_are_you_sure_empty_trash",
							cancelText: "tbd_cancel",
							okText: "tbd_empty"
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
						await drive.emptyTrash({
							signal: undefined
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

		if (menuButtons.length > 0) {
			items.push({
				type: "menu",
				props: {
					type: "dropdown",
					hitSlop: 20,
					buttons: menuButtons
				},
				triggerProps: {
					hitSlop: 20
				},
				icon: {
					name: "ellipsis-horizontal",
					size: 24,
					color: textForeground.color
				}
			})
		}

		if (items.length === 0) {
			return []
		}

		return items
	})()

	const leftItems = ((): HeaderItem[] => {
		if (drivePath.selectOptions) {
			return [
				{
					type: "button",
					icon: {
						name: "chevron-back-outline",
						color: textForeground.color,
						size: 20
					},
					props: {
						onPress: () => {
							if (router.canGoBack()) {
								router.back()
							}
						}
					}
				}
			] satisfies HeaderItem[]
		}

		if (selectedDriveItems.length > 0) {
			return [
				{
					type: "button",
					icon: {
						name: "close-outline",
						color: textForeground.color,
						size: 20
					},
					props: {
						onPress: () => {
							useDriveStore.getState().clearSelectedItems()
						}
					}
				}
			] satisfies HeaderItem[]
		}

		if (
			(drivePath.type === "drive" ||
				drivePath.type === "offline" ||
				drivePath.type === "sharedIn" ||
				drivePath.type === "sharedOut" ||
				drivePath.type === "favorites") &&
			drivePath.uuid
		) {
			return []
		}

		if (Platform.OS === "ios") {
			if (drivePath.type === "drive" && !drivePath.uuid) {
				return []
			}

			return [
				{
					type: "button",
					icon: {
						name: "chevron-back-outline",
						color: textForeground.color,
						size: 20
					},
					props: {
						onPress: () => {
							router.back()
						}
					}
				}
			] satisfies HeaderItem[]
		}

		return []
	})()

	const headerTitle = (() => {
		// In bulk-selection mode, swap the directory name out for the count —
		// matches Notes / Tracks / Contacts / Participants / Versions.
		// Picker mode (drivePath.selectOptions) keeps its own destination title.
		if (selectedDriveItems.length > 0 && !drivePath.selectOptions) {
			return `${selectedDriveItems.length} tbd_selected`
		}

		if (drivePath.selectOptions) {
			switch (drivePath.selectOptions.intention) {
				case "move": {
					return "tbd_select_destination"
				}

				case "select": {
					return drivePath.selectOptions.directories && drivePath.selectOptions.files
						? drivePath.selectOptions.type === "single"
							? "tbd_select_item"
							: "tbd_select_items"
						: drivePath.selectOptions.directories
							? drivePath.selectOptions.type === "single"
								? "tbd_select_directory"
								: "tbd_select_directories"
							: drivePath.selectOptions.type === "single"
								? "tbd_select_file"
								: "tbd_select_files"
				}
			}
		}

		// Resolve the breadcrumb title for the current directory. Prefers the
		// cached decrypted name; falls back to the cached DriveItem's display
		// name (which yields `cannot_decrypt_<uuid>` for undecryptable
		// directories) before the localized default.
		const resolveBreadcrumb = (fallback: string): string => {
			const uuid = drivePath.uuid ?? ""
			const cachedName = cache.directoryUuidToName.get(uuid)

			if (cachedName) {
				return cachedName
			}

			const cachedItem = cache.uuidToAnyDriveItem.get(uuid)

			if (cachedItem && cachedItem.data.undecryptable) {
				return driveItemDisplayName(cachedItem)
			}

			return fallback
		}

		switch (drivePath.type) {
			case "drive": {
				if (stringifiedClient && (drivePath.uuid ?? "") === stringifiedClient.rootUuid) {
					return "tbd_drive"
				}

				return resolveBreadcrumb("tbd_drive")
			}

			case "offline": {
				return resolveBreadcrumb("tbd_offline")
			}

			case "sharedIn": {
				return resolveBreadcrumb("tbd_shared_with_me")
			}

			case "sharedOut": {
				return resolveBreadcrumb("tbd_shared_with_others")
			}

			case "links": {
				return resolveBreadcrumb("tbd_links")
			}

			case "favorites": {
				return resolveBreadcrumb("tbd_favorites")
			}

			case "linked": {
				if (drivePath.linked && drivePath.linked.rootName) {
					return drivePath.linked.rootName
				}

				return resolveBreadcrumb("tbd_linked")
			}

			case "trash": {
				return "tbd_trash"
			}

			case "recents": {
				return "tbd_recents"
			}

			default: {
				return ""
			}
		}
	})()

	return (
		<StackHeader
			title={headerTitle}
			transparent={Platform.OS === "ios"}
			backVisible={leftItems.length === 0 && selectedDriveItems.length === 0}
			shadowVisible={Platform.OS === "ios" ? false : undefined}
			backgroundColor={
				drivePath.type !== "drive" || drivePath.selectOptions
					? Platform.select({
							ios: undefined,
							default: bgBackgroundSecondary.backgroundColor as string
						})
					: undefined
			}
			leftItems={leftItems}
			rightItems={rightItems}
			searchBarOptions={{
				placement: "integratedButton",
				placeholder: "tbd_search_drive",
				onChangeText: e => setSearchQuery(e.nativeEvent.text),
				onCancelButtonPress: () => setSearchQuery(""),
				onClose: () => setSearchQuery(""),
				onOpen: () => setSearchQuery(""),
				allowToolbarIntegration: false,
				headerIconColor: textForeground.color,
				textColor: textForeground.color,
				barTintColor: "transparent",
				tintColor: textForeground.color,
				hintTextColor: textMutedForeground.color,
				shouldShowHintSearchIcon: true,
				hideNavigationBar: false,
				hideWhenScrolling: false,
				inputType: "text"
			}}
		/>
	)
})

const Drive = memo(() => {
	const drivePath = useDrivePath()
	const [searchQuery, setSearchQuery] = useState<string>("")
	const [globalSearchResult, setGlobalSearchResult] = useState<DriveItem[]>([])
	const [queryingGlobalSearch, setQueryingGlobalSearch] = useState<boolean>(false)
	const { sort } = useDriveSortPreference(drivePath)

	const driveItemsQuery = useDriveItemsQuery(
		{
			path: drivePath
		},
		{
			enabled: drivePath.type !== null
		}
	)

	const itemsSorted = itemSorter.sortItems(
		[...(driveItemsQuery.status === "success" ? driveItemsQuery.data : []), ...globalSearchResult],
		sort
	)

	const items = (() => {
		if (driveItemsQuery.status !== "success") {
			return []
		}

		if (searchQuery.length > 0) {
			const searchQueryNormalized = searchQuery.trim().toLowerCase()

			return itemsSorted.filter(item => {
				// driveItemDisplayName returns `cannot_decrypt_<uuid>` for undecryptable
				// items so they remain searchable via the placeholder text.
				if (driveItemDisplayName(item).toLowerCase().includes(searchQueryNormalized)) {
					return true
				}

				return false
			})
		}

		return itemsSorted
	})()

	const debouncedSearch = (() => {
		return debounce(async (value: string) => {
			if (drivePath.type !== "drive" || drivePath.selectOptions) {
				setGlobalSearchResult([])
				setQueryingGlobalSearch(false)

				return
			}

			const normalized = value.trim().toLowerCase()

			if (normalized.length === 0) {
				setGlobalSearchResult([])
				setQueryingGlobalSearch(false)

				return
			}

			// Global search hits the SDK (findItemMatchesForName) — offline this
			// would throw a network error and produce a banner storm. Clear search
			// state silently; local-filter results (which stay applied via the
			// itemsSorted derivation above) still narrow the visible list.
			if (!onlineManager.isOnline()) {
				setGlobalSearchResult([])
				setQueryingGlobalSearch(false)

				return
			}

			setQueryingGlobalSearch(true)
			setGlobalSearchResult([])

			const result = await run(async defer => {
				defer(() => {
					setQueryingGlobalSearch(false)
				})

				return await drive.findItemMatchesForName({
					name: normalized
				})
			})

			setQueryingGlobalSearch(false)

			if (!result.success) {
				console.error(result.error)
				alerts.error(result.error)

				setGlobalSearchResult([])

				return
			}

			setGlobalSearchResult(result.data.map(({ item }) => item))
		}, 1000)
	})()

	useEffect(() => {
		if (drivePath.type !== "drive" || drivePath.selectOptions) {
			return
		}

		debouncedSearch(searchQuery)
	}, [searchQuery, debouncedSearch, drivePath.type, drivePath.selectOptions])

	useEffect(() => {
		return () => {
			debouncedSearch.cancel()
		}
	}, [debouncedSearch])

	useFocusEffect(
		useCallback(() => {
			useDriveStore.getState().clearSelectedItems()

			return () => {
				useDriveStore.getState().clearSelectedItems()
			}
		}, [])
	)

	return (
		<Fragment>
			<Header setSearchQuery={setSearchQuery} />
			<SafeAreaView
				className={cn(
					"flex-1",
					drivePath.type === "drive" && !drivePath.selectOptions ? "bg-background" : "bg-background-secondary"
				)}
				edges={["left", "right"]}
			>
				<VirtualList
					className={cn(
						"flex-1",
						drivePath.type === "drive" && !drivePath.selectOptions ? "bg-background" : "bg-background-secondary"
					)}
					contentInsetAdjustmentBehavior="automatic"
					contentContainerClassName={cn("pb-40", Platform.OS === "android" && "pb-96")}
					keyExtractor={(item: DriveItem) => {
						return item.data.uuid
					}}
					data={items}
					renderItem={(info: ListRenderItemInfo<DriveItem>) => {
						return (
							<Item
								info={info}
								drivePath={drivePath}
								getListItems={() => items}
							/>
						)
					}}
					onRefresh={async () => {
						if (!onlineManager.isOnline()) {
							return
						}

						const result = await run(async () => {
							return await driveItemsQuery.refetch()
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)
						}
					}}
					loading={driveItemsQuery.status !== "success" || queryingGlobalSearch}
					emptyComponent={() => (
						<ListEmpty
							icon={
								drivePath.type === "trash"
									? "trash-outline"
									: drivePath.type === "favorites"
										? "heart-outline"
										: drivePath.type === "recents"
											? "time-outline"
											: drivePath.type === "sharedIn" || drivePath.type === "sharedOut"
												? "people-outline"
												: drivePath.type === "links"
													? "link-outline"
													: drivePath.type === "offline"
														? "cloud-offline-outline"
														: "folder-open-outline"
							}
							title={
								drivePath.type === "trash"
									? "tbd_trash_is_empty"
									: drivePath.type === "favorites"
										? "tbd_no_favorites"
										: drivePath.type === "recents"
											? "tbd_no_recents"
											: drivePath.type === "sharedIn"
												? "tbd_no_shared_in_items"
												: drivePath.type === "sharedOut"
													? "tbd_no_shared_out_items"
													: drivePath.type === "links"
														? "tbd_no_links"
														: drivePath.type === "offline"
															? "tbd_no_offline_items"
															: "tbd_folder_is_empty"
							}
						/>
					)}
				/>
			</SafeAreaView>
		</Fragment>
	)
})

export default Drive
