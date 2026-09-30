import Drive from "@/features/drive/components"
import { Fragment } from "react"
import DriveSelectToolbar from "@/components/driveSelectToolbar"
import cache from "@/lib/cache"
import events from "@/lib/events"
import useDrivePath from "@/hooks/useDrivePath"
import useOnUnmountWithLatest from "@/hooks/useOnUnmountWithLatest"
import useDriveSelectStore from "@/features/drive/store/useDriveSelect.store"

const DriveSelectListener = () => {
	const drivePath = useDrivePath()

	useOnUnmountWithLatest(drivePath, current => {
		if (current.selectOptions && cache.rootUuid !== null && cache.rootUuid === current.uuid) {
			// A pick or copy the user dismissed resolves as cancelled; one already resolved ignores it.
			if (current.selectOptions.intention !== "move") {
				events.emit("driveSelect", {
					id: current.selectOptions.id,
					cancelled: true
				})
			}

			useDriveSelectStore.getState().closeSession(current.selectOptions.id)
		}
	})

	return null
}

const DriveSelect = () => {
	return (
		<Fragment>
			<Drive />
			<DriveSelectToolbar />
			<DriveSelectListener />
		</Fragment>
	)
}

export default DriveSelect
