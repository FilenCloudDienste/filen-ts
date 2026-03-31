import { Fragment, useState, useEffect, memo, useCallback } from "react"
import SafeAreaView from "@/components/ui/safeAreaView"
import StackHeader, { type HeaderItem } from "@/components/ui/header"
import useDrivePath from "@/hooks/useDrivePath"
import useDriveItemsQuery from "@/queries/useDriveItems.query"
import type { DriveItem } from "@/types"
import { itemSorter } from "@/lib/sort"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
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
import { useStringifiedClient } from "@/lib/auth"
import cache from "@/lib/cache"
import { AnyDirWithContext, AnyNormalDir, AnyDirWithContext_Tags } from "@filen/sdk-rs"
import { debounce } from "es-toolkit/function"
import * as ImagePicker from "expo-image-picker"
import transfers from "@/lib/transfers"
import * as FileSystem from "expo-file-system"
import { randomUUID } from "expo-crypto"
import { pack } from "@/lib/msgpack"
import { unwrapFileMeta, unwrappedFileIntoDriveItem, normalizeFilePathForExpo } from "@/lib/utils"
import { Buffer } from "react-native-quick-crypto"
import DocumentScanner, {
	ResponseType as DocumentScannerResponseType,
	ScanDocumentResponseStatus
} from "react-native-document-scanner-plugin"
import * as DocumentPicker from "expo-document-picker"

const Header = memo(({ parent }: { parent?: AnyDirWithContext }) => {
	const textForeground = useResolveClassNames("text-foreground")
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const selectedDriveItems = useDriveStore(useShallow(state => state.selectedItems))
	const drivePath = useDrivePath()
	const stringifiedClient = useStringifiedClient()

	const driveItemsQuery = useDriveItemsQuery(
		{
			path: drivePath
		},
		{
			enabled: false
		}
	)

	const driveItems = driveItemsQuery.status === "success" ? driveItemsQuery.data : []

	const rightItems = (() => {
		if (drivePath.selectOptions) {
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
							if (router.canGoBack()) {
								router.back()
							}
						}
					}
				}
			] satisfies HeaderItem[]
		}

		const items: HeaderItem[] = []
		const menuButtons: MenuButton[] = []

		if (driveItems.length > 0) {
			if (selectedDriveItems.length === driveItems.length) {
				menuButtons.push({
					id: "deselectAll",
					title: "tbd_deselect_all",
					onPress: () => {
						useDriveStore.getState().setSelectedItems([])
					}
				})
			} else {
				menuButtons.push({
					id: "selectAll",
					title: "tbd_select_all",
					onPress: () => {
						useDriveStore.getState().setSelectedItems(driveItems)
					}
				})
			}
		}

		if (
			parent &&
			parent.tag === AnyDirWithContext_Tags.Normal &&
			(drivePath.type === "drive" ||
				drivePath.type === "links" ||
				drivePath.type === "favorites" ||
				drivePath.type === "sharedOut") &&
			!drivePath.selectOptions
		) {
			menuButtons.push({
				id: "createFolder",
				title: "tbd_create_folder",
				icon: "plus",
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
							parent: parent.inner[0]
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
				icon: "plus",
				subButtons: [
					{
						id: "uploadFiles",
						title: "tbd_upload_files",
						icon: "plus",
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
													id: assetFile.uri,
													localFileOrDir: assetFile,
													parent: parent.inner[0],
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
								}
							}

							// TODO: display toast on upload success with number of successfully uploaded files and number of failed uploads
						}
					},
					{
						id: "uploadPhotosOrVideos",
						title: "tbd_upload_photos_or_videos",
						icon: "plus",
						onPress: async () => {
							const permissionsResult = await run(async () => {
								return await ImagePicker.requestMediaLibraryPermissionsAsync()
							})

							if (!permissionsResult.success) {
								console.error(permissionsResult.error)
								alerts.error(permissionsResult.error)

								return
							}

							if (!permissionsResult.data.granted) {
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
													id: assetFile.uri,
													localFileOrDir: assetFile,
													parent: parent.inner[0],
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
								}
							}

							// TODO: display toast on upload success with number of successfully uploaded files and number of failed uploads
						}
					},
					{
						id: "takePhotoOrVideo",
						title: "tbd_take_photo_or_video",
						icon: "plus",
						onPress: async () => {
							const permissionsResult = await run(async () => {
								return await ImagePicker.requestCameraPermissionsAsync()
							})

							if (!permissionsResult.success) {
								console.error(permissionsResult.error)
								alerts.error(permissionsResult.error)

								return
							}

							if (!permissionsResult.data.granted) {
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
													id: assetFile.uri,
													localFileOrDir: assetFile,
													parent: parent.inner[0],
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
								}
							}

							// TODO: display toast on upload success with number of successfully uploaded files and number of failed uploads
						}
					},
					{
						id: "scanDocument",
						title: "tbd_scan_document",
						icon: "plus",
						onPress: async () => {
							const permissionsResult = await run(async () => {
								return await ImagePicker.requestCameraPermissionsAsync()
							})

							if (!permissionsResult.success) {
								console.error(permissionsResult.error)
								alerts.error(permissionsResult.error)

								return
							}

							if (!permissionsResult.data.granted) {
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
													id: scanFile.uri,
													localFileOrDir: scanFile,
													parent: parent.inner[0],
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
								}
							}

							// TODO: display toast on upload success with number of successfully uploaded files and number of failed uploads
						}
					},
					{
						id: "createTextFile",
						title: "tbd_create_text_file",
						icon: "plus",
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
								const tmpFile = new FileSystem.File(FileSystem.Paths.join(FileSystem.Paths.cache, randomUUID(), fileName))

								defer(() => {
									if (tmpFile.parentDirectory.exists) {
										tmpFile.parentDirectory.delete()
									}
								})

								if (!tmpFile.parentDirectory.exists) {
									tmpFile.parentDirectory.create({
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
									id: tmpFile.uri,
									localFileOrDir: tmpFile,
									parent: parent.inner[0],
									hideProgress: true,
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

							const file = result.data.files.at(0)

							if (!file) {
								return
							}

							const item = unwrappedFileIntoDriveItem(unwrapFileMeta(file))

							router.push({
								pathname: "/drivePreview",
								params: {
									item: Buffer.from(pack(item)).toString("base64"),
									drivePath: Buffer.from(pack(drivePath)).toString("base64"),
									parent: Buffer.from(pack(parent)).toString("base64")
								}
							})
						}
					}
				]
			})
		}

		if (selectedDriveItems.length > 0 && drivePath.type === "trash") {
			menuButtons.push({
				id: "restoreSelected",
				title: "tbd_restore_selected",
				onPress: async () => {
					const promptResult = await run(async () => {
						return await prompts.alert({
							title: "tbd_restore_selected",
							message: "tbd_are_you_sure_restore_selected",
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
						await Promise.all(
							selectedDriveItems.map(item => {
								return drive.restore({
									item,
									signal: undefined
								})
							})
						)
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)
					}
				}
			})

			menuButtons.push({
				id: "deleteSelectedPermanently",
				title: "tbd_delete_selected_permanently",
				destructive: true,
				icon: "delete",
				onPress: async () => {
					const promptResult = await run(async () => {
						return await prompts.alert({
							title: "tbd_delete_selected_permanently",
							message: "tbd_are_you_sure_delete_selected_permanently",
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
						await Promise.all(
							selectedDriveItems.map(item => {
								return drive.deletePermanently({
									item,
									signal: undefined
								})
							})
						)
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)
					}
				}
			})
		}

		if (drivePath.type === "trash") {
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
							useDriveStore.getState().setSelectedItems([])
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

		switch (drivePath.type) {
			case "drive": {
				if (stringifiedClient && (drivePath.uuid ?? "") === stringifiedClient.rootUuid) {
					return "tbd_drive"
				}

				return cache.directoryUuidToName.get(drivePath.uuid ?? "") ?? "tbd_drive"
			}

			case "offline": {
				return cache.directoryUuidToName.get(drivePath.uuid ?? "") ?? "tbd_offline"
			}

			case "sharedIn": {
				return cache.directoryUuidToName.get(drivePath.uuid ?? "") ?? "tbd_shared_with_me"
			}

			case "sharedOut": {
				return cache.directoryUuidToName.get(drivePath.uuid ?? "") ?? "tbd_shared_with_others"
			}

			case "links": {
				return cache.directoryUuidToName.get(drivePath.uuid ?? "") ?? "tbd_links"
			}

			case "favorites": {
				return cache.directoryUuidToName.get(drivePath.uuid ?? "") ?? "tbd_favorites"
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
		/>
	)
})

const Drive = memo(() => {
	const drivePath = useDrivePath()
	const stringifiedClient = useStringifiedClient()
	const [searchQuery, setSearchQuery] = useState<string>("")
	const [globalSearchResult, setGlobalSearchResult] = useState<DriveItem[]>([])
	const [queryingGlobalSearch, setQueryingGlobalSearch] = useState<boolean>(false)

	const driveItemsQuery = useDriveItemsQuery(
		{
			path: drivePath
		},
		{
			enabled: drivePath.type !== null
		}
	)

	const parent = ((): AnyDirWithContext | undefined => {
		if (drivePath.type === "drive" && stringifiedClient && (!drivePath.uuid || (drivePath.uuid ?? "") === stringifiedClient.rootUuid)) {
			return new AnyDirWithContext.Normal(
				new AnyNormalDir.Root({
					uuid: stringifiedClient.rootUuid
				})
			)
		}

		const fromCache = cache.directoryUuidToAnyDirWithContext.get(drivePath.uuid ?? "")

		if (fromCache) {
			return fromCache
		}

		return undefined
	})()

	const renderItem = (info: ListRenderItemInfo<DriveItem>) => {
		return (
			<Item
				info={{
					...info,
					item: {
						item: info.item,
						parent
					}
				}}
				origin={drivePath.type ?? "drive"}
				drivePath={drivePath}
			/>
		)
	}

	const keyExtractor = (item: DriveItem) => {
		return item.data.uuid
	}

	const itemsSorted = itemSorter.sortItems(
		[...(driveItemsQuery.status === "success" ? driveItemsQuery.data : []), ...globalSearchResult],
		drivePath.type === "recents" ? "uploadDateDesc" : "nameAsc"
	)

	const items = (() => {
		if (driveItemsQuery.status !== "success") {
			return []
		}

		if (searchQuery.length > 0) {
			const searchQueryNormalized = searchQuery.trim().toLowerCase()

			return itemsSorted.filter(item => {
				if (item.data.decryptedMeta?.name && item.data.decryptedMeta?.name.toLowerCase().includes(searchQueryNormalized)) {
					return true
				}

				return false
			})
		}

		return itemsSorted
	})()

	const debouncedSearch = (() => {
		return debounce(async (value: string) => {
			const normalized = value.trim().toLowerCase()

			if (normalized.length === 0) {
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

	const searchBarProps = {
		placeholder: "tbd_search_drive",
		onChangeText: setSearchQuery
	}

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
			useDriveStore.getState().setSelectedItems([])

			return () => {
				useDriveStore.getState().setSelectedItems([])
			}
		}, [])
	)

	return (
		<Fragment>
			<Header parent={parent} />
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
					keyExtractor={keyExtractor}
					data={items}
					renderItem={renderItem}
					onRefresh={async () => {
						const result = await run(async () => {
							return await driveItemsQuery.refetch()
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)
						}
					}}
					loading={driveItemsQuery.status !== "success" || queryingGlobalSearch}
					searchBar={searchBarProps}
				/>
			</SafeAreaView>
		</Fragment>
	)
})

export default Drive
