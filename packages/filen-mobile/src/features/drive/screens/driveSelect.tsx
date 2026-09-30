import Drive from "@/features/drive/components"
import { Fragment, useEffect, useRef } from "react"
import DriveSelectToolbar from "@/components/driveSelectToolbar"
import { useSdkClients } from "@/lib/auth"
import events from "@/lib/events"
import useDrivePath from "@/hooks/useDrivePath"
import useDriveSelectStore from "@/features/drive/store/useDriveSelect.store"

const DriveSelectListener = () => {
	const drivePath = useDrivePath()
	const { authedSdkClient } = useSdkClients()

	// Latest values in refs so the cancel effect runs on unmount ONLY — depending on them
	// directly re-runs the cleanup on re-renders (useDrivePath returns a fresh object per
	// render), which can emit a spurious `cancelled: true` that silently aborts the
	// selection flow (same class as the contacts-picker share bug; mirrors playlists.tsx).
	const cancelStateRef = useRef({ drivePath, authedSdkClient })

	useEffect(() => {
		cancelStateRef.current = { drivePath, authedSdkClient }
	})

	useEffect(() => {
		return () => {
			const current = cancelStateRef.current

			if (current.drivePath.selectOptions && current.authedSdkClient?.root().uuid === current.drivePath.uuid) {
				// A pick or copy the user dismissed resolves as cancelled; one already resolved ignores it.
				if (current.drivePath.selectOptions.intention !== "move") {
					events.emit("driveSelect", {
						id: current.drivePath.selectOptions.id,
						cancelled: true
					})
				}

				useDriveSelectStore.getState().closeSession(current.drivePath.selectOptions.id)
			}
		}
	}, [])

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
