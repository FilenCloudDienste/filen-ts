import { create } from "zustand"

export type VisibleDateRange = {
	start: number | null
	end: number | null
}

export type PhotosStore = {
	visibleDateRange: VisibleDateRange | null
	setVisibleDateRange: (fn: VisibleDateRange | null | ((prev: VisibleDateRange | null) => VisibleDateRange | null)) => void
}

export const usePhotosStore = create<PhotosStore>(set => ({
	visibleDateRange: null,
	setVisibleDateRange(fn) {
		set(state => ({
			visibleDateRange: typeof fn === "function" ? fn(state.visibleDateRange) : fn
		}))
	}
}))

export default usePhotosStore
