import { memo } from "react"
import Gallery from "@/components/drivePreview/gallery"
import DismissStack from "@/components/dismissStack"
import { useShallow } from "zustand/shallow"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"

export type External = {
	name: string
	url: string
}

const DrivePreview = memo(() => {
	const currentItem = useDrivePreviewStore(useShallow(state => state.currentItem))

	if (!currentItem) {
		return <DismissStack />
	}

	return <Gallery />
})

export default DrivePreview
