import { toast } from "sonner"
import type { Playlist } from "@filen/shared"
import { listRest, MAX_ARRAY_ITEMS } from "@filen/shared/assistant"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { playlistsQueryRead } from "@/features/audio/queries/playlists"
import { playlistFileTrack } from "@/features/audio/lib/playlists"
import { playPlaylistFrom } from "@/features/audio/lib/playlistPlayback"
import { audioEngine } from "@/features/audio/lib/audioEngine"
import { deriveAudioHandoff, isAudioItem } from "@/features/audio/lib/handoff"
import { useAudioStore } from "@/features/audio/store/useAudioStore"
import { cachedListing } from "@/features/drive/queries/drive"
import { isDirectoryItem, type DriveItem } from "@/features/drive/lib/item"
import { sortListing } from "@/features/assistant/tools/drive"
import { assistantRouter, navigateChecked } from "@/features/assistant/tools/navigation"
import {
	driveName,
	freshDriveItem,
	freshPlaylist,
	readDriveListing,
	readSharedInListing,
	requiredString,
	resolveHandle,
	rootDirUuid,
	shareDirection,
	type ToolAdapter
} from "@/features/assistant/tools/entities"
import { AssistantToolError, throwIfStopped } from "@/features/assistant/tools/format"

const TRACK_LIMIT = MAX_ARRAY_ITEMS

export const listPlaylistsTool: ToolAdapter = async (_input, scope) => {
	const playlists = (await playlistsQueryRead()).flatMap(entry => (entry.status === "ok" ? [entry.playlist] : []))

	return {
		value: {
			playlists: playlists.slice(0, MAX_ARRAY_ITEMS).map(playlist => ({
				handle: scope.show({ kind: "playlist", playlist }, playlist.name),
				name: playlist.name,
				tracks: playlist.files.length
			})),
			...listRest(playlists.length)
		}
	}
}

export const openPlaylistTool: ToolAdapter = async (input, scope) => {
	const entity = await resolveHandle(scope, requiredString(input, "handle"), ["playlist"])
	const router = assistantRouter()

	if (entity.kind !== "playlist") {
		throw new AssistantToolError("Not a playlist", { invalid: true })
	}

	if (router === null) {
		throw new AssistantToolError("The app cannot navigate right now")
	}

	const playlist = freshPlaylist(entity.playlist)

	await navigateChecked({
		router,
		navigate: () => router.navigate({ to: "/playlists/$uuid", params: { uuid: playlist.uuid } }),
		landed: pathname => pathname === `/playlists/${playlist.uuid}`,
		signal: scope.signal
	})

	return {
		value: {
			opened: playlist.name,
			// A track handle plays the playlist from that track on, as clicking its row does.
			tracks: playlist.files.slice(0, TRACK_LIMIT).map(file => {
				const track = playlistFileTrack(file)

				return { handle: scope.show({ kind: "track", track, playlist }, track.name), name: track.name }
			}),
			...listRest(playlist.files.length, TRACK_LIMIT)
		}
	}
}

// Opening an audio file in a listing queues its audio siblings in listing order; the assistant does the
// same with the file's directory listing when the drive has it, else the file alone.
function driveQueue(item: DriveItem): ReturnType<typeof deriveAudioHandoff> {
	const parent = item.data.parent === rootDirUuid() ? null : item.data.parent
	const siblings = cachedListing("drive", parent)
	const listing = siblings?.some(sibling => sibling.data.uuid === item.data.uuid) === true ? siblings : [item]

	return deriveAudioHandoff(listing, item.data.uuid, false)
}

// A directory's audio files in name order, from its own listing (the drive screen's query, cached when the
// user browsed it): the queue a click on its first track would build.
async function directoryQueue(item: DriveItem, shared: readonly string[] | undefined): Promise<ReturnType<typeof deriveAudioHandoff>> {
	const listing =
		shareDirection(item) === "in"
			? await readSharedInListing(item.data.uuid, shared ?? [item.data.uuid])
			: await readDriveListing(item.data.uuid)
	const ordered = sortListing(listing, "name", "modified")
	const first = ordered.find(entry => isAudioItem(entry) && !entry.data.undecryptable)

	return first === undefined ? null : deriveAudioHandoff(ordered, first.data.uuid, false)
}

// The playlist screen's Play: the toast on failure is the one startPlaylist shows.
async function playPlaylist(playlist: Playlist): Promise<void> {
	if (playlist.files.length === 0) {
		throw new AssistantToolError(`Playlist "${playlist.name}" is empty`)
	}

	try {
		await playPlaylistFrom(playlist, 0)
	} catch (e) {
		toast.error(errorLabel(e))

		throw new AssistantToolError(errorLabel(e))
	}
}

export const playTool: ToolAdapter = async (input, scope) => {
	const entity = await resolveHandle(scope, requiredString(input, "handle"), ["drive", "playlist", "track"])

	switch (entity.kind) {
		case "playlist": {
			const playlist = freshPlaylist(entity.playlist)

			throwIfStopped(scope)
			await playPlaylist(playlist)

			return { value: { playing: playlist.files[0]?.name ?? "", playlist: playlist.name } }
		}

		case "track": {
			const playlist = entity.playlist === undefined ? undefined : freshPlaylist(entity.playlist)
			const index = playlist?.files.findIndex(file => playlistFileTrack(file).uuid === entity.track.uuid) ?? -1

			throwIfStopped(scope)

			if (playlist !== undefined && index >= 0) {
				await playPlaylistFrom(playlist, index)
			} else {
				await audioEngine.enqueueAndPlay([entity.track], 0)
			}

			return { value: { playing: entity.track.name } }
		}

		case "drive": {
			const item = freshDriveItem(entity.item)

			if (isDirectoryItem(item)) {
				if (item.data.undecryptable) {
					throw new AssistantToolError("This directory cannot be decrypted")
				}

				const queue = await directoryQueue(item, entity.shared)

				throwIfStopped(scope)

				if (queue === null) {
					throw new AssistantToolError(`"${driveName(item)}" holds no audio files`)
				}

				await audioEngine.enqueueAndPlay(queue.tracks, queue.startIndex)

				return {
					value: { playing: queue.tracks[queue.startIndex]?.name ?? "", directory: driveName(item), tracks: queue.tracks.length }
				}
			}

			const handoff = isAudioItem(item) ? driveQueue(item) : null

			if (handoff === null) {
				throw new AssistantToolError(`"${driveName(item)}" is not an audio file`, { invalid: true })
			}

			throwIfStopped(scope)
			await audioEngine.enqueueAndPlay(handoff.tracks, handoff.startIndex)

			return { value: { playing: driveName(item) } }
		}

		default:
			throw new AssistantToolError("Not playable", { invalid: true })
	}
}

// The player bar's and queue toggles' own engine calls.
export const audioControlTool: ToolAdapter = async input => {
	const action = requiredString(input, "action")
	const { queue, currentIndex } = useAudioStore.getState()
	const current = queue[currentIndex]

	if (current === undefined) {
		throw new AssistantToolError("Nothing is playing")
	}

	switch (action) {
		case "pause":
			audioEngine.pause()
			break
		case "resume":
			audioEngine.resume()
			break
		case "next":
			await audioEngine.skipNext()
			break
		case "previous":
			await audioEngine.skipPrevious()
			break
		case "stop":
			audioEngine.clearQueue()
			break
		case "shuffle_on":
		case "shuffle_off":
			audioEngine.setShuffleEnabled(action === "shuffle_on")
			break
		case "repeat_on":
		case "repeat_off":
			audioEngine.setLoopMode(action === "repeat_on" ? "all" : "off")
			break
		default:
			throw new AssistantToolError(`Unknown action "${action}"`, { invalid: true })
	}

	const state = useAudioStore.getState()
	const now = state.queue[state.currentIndex]

	return {
		value: { done: action, ...(now === undefined ? {} : { track: now.name, status: state.status }) }
	}
}
