import { create } from "zustand"
import type { GalleryItemTagged, InitialItem } from "@/components/drivePreview/gallery"
import { router } from "@/lib/router"
import type { DrivePath } from "@/hooks/useDrivePath"
import { getPreviewType, isImagePreviewType } from "@/lib/previewType"
import { EXPO_IMAGE_SUPPORTED_EXTENSIONS } from "@/constants"
import { Paths } from "expo-file-system"

export type OpenPreviewParams = {
	items: GalleryItemTagged[]
	initialItem: InitialItem
}

// The guarded router (src/lib/router.ts) dedupes by navigation TARGET, and every preview open is the
// same "/drivePreview" string — so two opens inside NAV_DEDUPE_WINDOW_MS would collapse into a single
// push while BOTH had already seeded the store, stranding it with a session that has no screen. The
// open() guard would then never clear and the preview would stay dead for the rest of the process.
// Distinct sessions ARE distinct navigations; a genuinely double-fired tap is already dropped by
// open()'s own guard, which is the correct place for it (it knows an item is already showing).
let openSessionCounter = 0

export type DrivePreviewStore = {
	headerHeight: number | null
	currentItem: GalleryItemTagged | null
	currentIndex: number | null
	items: GalleryItemTagged[]
	initialScrollIndex: number
	drivePath: DrivePath | null
	// True from the moment the open gallery commits to leaving (its route pop was dispatched) until it
	// actually unmounts — i.e. for the length of the pop animation, during which its data deliberately
	// stays in the store to paint that animation. open() needs this to tell "a preview owns the screen"
	// apart from "a preview is on its way out".
	isLeaving: boolean
	setLeaving: (leaving: boolean) => void
	// An open() that landed during the leaving window. Replayed by endSession() once the outgoing
	// gallery unmounts; only the newest is kept, so the user's last tap wins.
	pendingOpen: OpenPreviewParams | null
	setHeaderHeight: (fn: number | null | ((prev: number | null) => number | null)) => void
	setCurrentIndex: (fn: number | null | ((prev: number | null) => number | null)) => void
	reset: () => void
	// Called by the gallery when it unmounts: clears the session and replays a parked open.
	endSession: () => void
	setCurrentItem: (fn: GalleryItemTagged | null | ((prev: GalleryItemTagged | null) => GalleryItemTagged | null)) => void
	setCurrentItems: (fn: GalleryItemTagged[] | ((prev: GalleryItemTagged[]) => GalleryItemTagged[])) => void
	open(params: OpenPreviewParams): void
	setInitialScrollIndex: (fn: number | ((prev: number) => number)) => void
	setDrivePath: (fn: DrivePath | null | ((prev: DrivePath | null) => DrivePath | null)) => void
	// Whether the currently-open editable text preview has unsaved edits. Published by previewText;
	// read by the route-level unsaved-changes guard to decide whether to prompt on navigate-away.
	hasUnsavedEdits: boolean
	setHasUnsavedEdits: (value: boolean) => void
	// Saves the current editable text preview. Returns true once saved (so the guard can proceed to
	// leave), false if it could not save (e.g. offline) — in which case the guard keeps the user put.
	saveEdits: (() => Promise<boolean>) | null
	setSaveEdits: (fn: (() => Promise<boolean>) | null) => void
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
			drivePath: null,
			hasUnsavedEdits: false,
			saveEdits: null,
			isLeaving: false,
			pendingOpen: null
		})
	},
	isLeaving: false,
	setLeaving(leaving) {
		// Unwinding the latch also drops anything parked behind it: a dismissal that was BLOCKED (the
		// unsaved-changes prompt cancelled, or a failed save) keeps this gallery alive, so a tap that
		// landed during the prompt must not fire later when the user eventually does leave.
		set(leaving ? { isLeaving: true } : { isLeaving: false, pendingOpen: null })
	},
	pendingOpen: null,
	endSession() {
		const pending = get().pendingOpen

		get().reset()

		if (pending) {
			get().open(pending)
		}
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
	hasUnsavedEdits: false,
	setHasUnsavedEdits(value) {
		set({
			hasUnsavedEdits: value
		})
	},
	saveEdits: null,
	setSaveEdits(fn) {
		set({
			saveEdits: fn
		})
	},
	open({ items, initialItem }) {
		if (get().currentIndex !== null || get().currentItem !== null) {
			// A gallery that has committed to leaving still holds the store for the length of its pop
			// animation, so this tap would otherwise be swallowed — and "close the preview, tap the next
			// photo" is a routine gesture, not a mis-tap. Park it; endSession() replays it the moment the
			// outgoing gallery unmounts. While a preview is genuinely VISIBLE the same call is a
			// double-fired tap and stays dropped.
			if (get().isLeaving) {
				set({
					pendingOpen: {
						items,
						initialItem
					}
				})
			}

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
						(isImagePreviewType(previewType) || previewType === "video") &&
						(isImagePreviewType(previewType)
							? EXPO_IMAGE_SUPPORTED_EXTENSIONS.has(Paths.extname(item.data.data.decryptedMeta.name).toLowerCase())
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

				return isImagePreviewType(type) || type === "video" || type === "audio"
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

		openSessionCounter++

		router.push({
			pathname: "/drivePreview",
			params: {
				session: String(openSessionCounter)
			}
		})
	}
}))

export default useDrivePreviewStore
