import { useEffect, useRef, useState } from "react"
import type { DriveItem } from "@/features/drive/lib/item"
import type { VideoEditClient, VideoSourceInfo } from "@/features/preview/videoEdit/types"
import { log } from "@/lib/log"

// The preview overlay's video edit mode: opening a client for the file on screen, reading the source once, opening the
// editor only when this browser can show its picture, and ending the client when the editor closes (or the overlay
// does). The overlay decides when Edit is offered (canEditVideo, the slot's category) and checks the open session still
// belongs to the slot on screen (frozenUuid, uuid), as it does for the image editor.

export interface VideoEditState {
	client: VideoEditClient
	info: VideoSourceInfo
	// The pager slot's uuid as it opened, and the version's.
	frozenUuid: string
	uuid: string
}

export type EnterVideoEditOutcome = "ready" | "unavailable" | "failed" | "superseded"

// Files found to have no picture this browser can show, this session: Edit is not offered for them again.
const unpreviewable = new Set<string>()

export function knownUnpreviewable(uuid: string): boolean {
	return unpreviewable.has(uuid)
}

export function useVideoEditMode(createClient: (item: DriveItem) => VideoEditClient): {
	state: VideoEditState | null
	entering: boolean
	enter: (item: DriveItem, frozenUuid: string) => Promise<EnterVideoEditOutcome>
	exit: () => void
} {
	const [state, setState] = useState<VideoEditState | null>(null)
	const [entering, setEntering] = useState(false)
	// Bumped by every entry, exit and unmount: an entry that finds it moved on was overtaken and ends its client.
	const attempt = useRef(0)

	useEffect(() => {
		if (state === null) {
			return
		}

		const client = state.client

		return () => {
			client.dispose()
		}
	}, [state])

	useEffect(() => {
		const current = attempt

		return () => {
			current.current++
		}
	}, [])

	const enter = async (item: DriveItem, frozenUuid: string): Promise<EnterVideoEditOutcome> => {
		const id = ++attempt.current
		const client = createClient(item)

		setEntering(true)

		const info = await client.loadSource().catch((error: unknown) => {
			log.error("[videoEdit] reading the source failed", error)

			return null
		})

		if (id !== attempt.current) {
			client.dispose()

			return "superseded"
		}

		setEntering(false)

		if (info === null) {
			client.dispose()

			return "failed"
		}

		if (!info.previewable) {
			unpreviewable.add(item.data.uuid)
			client.dispose()

			return "unavailable"
		}

		setState({ client, info, frozenUuid, uuid: item.data.uuid })

		return "ready"
	}

	const exit = (): void => {
		attempt.current++
		setEntering(false)
		setState(null)
	}

	return { state, entering, enter, exit }
}
