import { create } from "zustand"

export type PhotosStore = {
	visibleDate: number | null
	setVisibleDate: (visibleDate: number | null) => void
}

export const usePhotosStore = create<PhotosStore>(set => ({
	visibleDate: null,
	setVisibleDate(visibleDate) {
		set({
			visibleDate
		})
	}
}))

export default usePhotosStore
