import { create } from "zustand"
import type { GalleryItemTagged, InitialItem } from "@/components/drivePreview/gallery"
import { router } from "expo-router"
import type { DrivePath } from "@/hooks/useDrivePath"
import { getPreviewType } from "@/lib/utils"
import { EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS } from "@/constants"
import { Paths } from "expo-file-system"

export type DrivePreviewStore = {
	headerHeight: number | null
	currentItem: GalleryItemTagged | null
	currentIndex: number | null
	items: GalleryItemTagged[]
	initialScrollIndex: number
	drivePath: DrivePath | null
	setHeaderHeight: (fn: number | null | ((prev: number | null) => number | null)) => void
	setCurrentIndex: (fn: number | null | ((prev: number | null) => number | null)) => void
	reset: () => void
	setCurrentItem: (fn: GalleryItemTagged | null | ((prev: GalleryItemTagged | null) => GalleryItemTagged | null)) => void
	setCurrentItems: (fn: GalleryItemTagged[] | ((prev: GalleryItemTagged[]) => GalleryItemTagged[])) => void
	open(params: { items: GalleryItemTagged[]; initialItem: InitialItem }): void
	setInitialScrollIndex: (fn: number | ((prev: number) => number)) => void
	setDrivePath: (fn: DrivePath | null | ((prev: DrivePath | null) => DrivePath | null)) => void
}

export const useDrivePreviewStore = create<DrivePreviewStore>((set, get) => ({
	headerHeight: null,
	setHeaderHeight(fn) {
		set(state => ({
			headerHeight: typeof fn === "function" ? fn(state.headerHeight) : fn
		}))
	},
	currentIndex: null,
	setCurrentIndex(fn) {
		set(state => ({
			currentIndex: typeof fn === "function" ? fn(state.currentIndex) : fn
		}))
	},
	reset() {
		set({
			currentIndex: null,
			currentItem: null,
			initialScrollIndex: 0,
			items: [],
			drivePath: null
		})
	},
	currentItem: null,
	setCurrentItem(fn) {
		set(state => ({
			currentItem: typeof fn === "function" ? fn(state.currentItem) : fn
		}))
	},
	items: [],
	setCurrentItems(fn) {
		set(state => ({
			items: typeof fn === "function" ? fn(state.items) : fn
		}))
	},
	initialScrollIndex: 0,
	setInitialScrollIndex(fn) {
		set(state => ({
			initialScrollIndex: typeof fn === "function" ? fn(state.initialScrollIndex) : fn
		}))
	},
	drivePath: null,
	setDrivePath(fn) {
		set(state => ({
			drivePath: typeof fn === "function" ? fn(state.drivePath) : fn
		}))
	},
	open({ items, initialItem }) {
		if (get().currentIndex !== null || get().currentItem !== null) {
			return
		}

		const itemsFiltered = ((): GalleryItemTagged[] => {
			if (initialItem.type === "external") {
				return [
					{
						type: "external",
						data: initialItem.data
					}
				]
			}

			const basePreviewType = getPreviewType(initialItem.data.item.data.decryptedMeta?.name ?? "")

			// If it's a docx, text, pdf, or code file, we won't show the gallery and just show that file, so we return an array with just that file as the item to render
			if (basePreviewType === "docx" || basePreviewType === "text" || basePreviewType === "pdf" || basePreviewType === "code") {
				return [
					{
						type: "drive",
						data: initialItem.data.item
					}
				]
			}

			if (initialItem.data.drivePath.type === "photos") {
				return items.filter(item => {
					if (
						item.type !== "drive" ||
						!item.data.data.decryptedMeta ||
						(item.data.type !== "file" && item.data.type !== "sharedFile" && item.data.type !== "sharedRootFile")
					) {
						return false
					}

					const previewType = getPreviewType(item.data.data.decryptedMeta.name)

					return (
						(previewType === "image" || previewType === "video") &&
						(previewType === "image"
							? EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS.has(Paths.extname(item.data.data.decryptedMeta.name))
							: true)
					)
				})
			}

			return items.filter(item => {
				if (
					item.type !== "drive" ||
					!item.data.data.decryptedMeta ||
					(item.data.type !== "file" && item.data.type !== "sharedFile" && item.data.type !== "sharedRootFile")
				) {
					return false
				}

				const type = getPreviewType(item.data.data.decryptedMeta?.name ?? "")

				return type === "image" || type === "video" || type === "audio"
			})
		})()

		const initialScrollIndex =
			initialItem.type === "external"
				? 0
				: itemsFiltered.findIndex(i => (i.type === "drive" ? i.data.data.uuid === initialItem.data.item.data.uuid : false))
		const initItem = itemsFiltered[initialScrollIndex]

		if (!initItem) {
			return
		}

		get().reset()

		set({
			currentItem: initItem,
			items: itemsFiltered,
			initialScrollIndex,
			currentIndex: initialScrollIndex,
			drivePath: initialItem.type === "drive" ? initialItem.data.drivePath : null
		})

		router.push("/drivePreview")
	}
}))

export default useDrivePreviewStore
