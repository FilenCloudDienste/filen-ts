import { Fragment } from "react"
import Gallery from "@/components/drivePreview/gallery"
import DismissStack from "@/components/dismissStack"
import UnsavedChangesGuard from "@/components/drivePreview/unsavedChangesGuard"
import { useShallow } from "zustand/shallow"
import useDrivePreviewStore from "@/stores/useDrivePreview.store"

export type External = {
	name: string
	url: string
}

const DrivePreview = () => {
	const currentItem = useDrivePreviewStore(useShallow(state => state.currentItem))

	return (
		<Fragment>
			{!currentItem ? <DismissStack /> : <Gallery />}
			<UnsavedChangesGuard />
		</Fragment>
	)
}

export default DrivePreview
