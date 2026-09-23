import type { SocketEvent } from "@filen/sdk-rs"
import { registerSocketHandler } from "@/lib/sdk/socket"
import { isPlaylistsDriveEvent } from "@/features/audio/lib/playlists"
import { markPlaylistsUnsynced } from "@/features/audio/queries/playlists"

// The realtime playlists handlers, registered on the generic socket bridge beside drive's own. They only
// mark the playlists cache unsynced, never fetch: the next mount/focus/reconnect re-reads it, and an open
// list doesn't re-download every playlist per event (this tab's own saves echo back as events too).

type DriveSocketEvent = Extract<SocketEvent, { type: "drive" }>

export function handlePlaylistsDriveEvent(event: DriveSocketEvent): void {
	if (isPlaylistsDriveEvent(event.inner)) {
		markPlaylistsUnsynced()
	}
}

// Called once by the authed shell's socket host; returns the combined unregister fn. A malformed drive
// event can't be ruled out as a playlist change, and events are lost while the socket is down, so a drop
// and every (re)authentication unsync too.
export function registerPlaylistSocketHandlers(): () => void {
	const unregisterDrive = registerSocketHandler("drive", handlePlaylistsDriveEvent)
	const unregisterMalformed = registerSocketHandler("driveMalformed", markPlaylistsUnsynced)
	const unregisterReconnecting = registerSocketHandler("reconnecting", markPlaylistsUnsynced)
	const unregisterAuthSuccess = registerSocketHandler("authSuccess", markPlaylistsUnsynced)

	return () => {
		unregisterDrive()
		unregisterMalformed()
		unregisterReconnecting()
		unregisterAuthSuccess()
	}
}
