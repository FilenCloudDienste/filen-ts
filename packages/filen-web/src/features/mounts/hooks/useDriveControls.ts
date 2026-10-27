import { useState } from "react"
import { useShallow } from "zustand/shallow"
import type { DesktopDrive, DesktopDrivePatch, DesktopFuseStatus } from "@filen/shared/desktop"
import { mountsApi, useMountsDrive, useMountsStore } from "@/features/mounts/lib/mountsStore"
import { runMountsAction } from "@/features/mounts/lib/mountsActions"
import { roleBusy } from "@/features/mounts/lib/mountsStatus.logic"

export interface DriveControls {
	drive: DesktopDrive
	available: boolean
	fuse: DesktopFuseStatus | null
	// A call in flight, or the shell mid-transition: the drive's controls wait.
	busy: boolean
	// Nothing to mount with (no rclone, no FUSE): only turning it off stays possible.
	cannotMount: boolean
	setDrive: (patch: Pick<DesktopDrivePatch, "enabled" | "readOnly">) => void
}

// The one path every drive switch takes, on its page and in the overview. null before the first overview.
export function useDriveControls(): DriveControls | null {
	const drive = useMountsDrive()
	const available = useMountsStore(state => state.overview?.available ?? true)
	const fuse = useMountsStore(useShallow(state => state.overview?.fuse ?? null))
	const [pending, setPending] = useState(false)

	if (drive === null) {
		return null
	}

	return {
		drive,
		available,
		fuse,
		busy: pending || roleBusy(drive.state),
		cannotMount: !available || fuse?.state === "missing",
		setDrive: patch => {
			setPending(true)
			void runMountsAction(() => mountsApi().setDrive(patch)).finally(() => {
				setPending(false)
			})
		}
	}
}
