import { vi, describe, it, expect } from "vitest"

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import of the module under test
// ---------------------------------------------------------------------------

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))
vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

vi.mock("@/lib/alerts", () => ({
	default: { error: vi.fn(), normal: vi.fn() }
}))

vi.mock("@/components/ui/fullScreenLoadingModal", () => ({
	runWithLoading: vi.fn(async (fn: () => Promise<unknown>) => {
		try {
			const data = await fn()

			return { success: true, data }
		} catch (error) {
			return { success: false, error }
		}
	})
}))

vi.mock("@/features/audio/audio", () => ({
	default: {
		replaceQueue: vi.fn(),
		play: vi.fn(),
		addToQueue: vi.fn(),
		getQueue: vi.fn(() => []),
		savePlaylist: vi.fn()
	},
	useIsCurrentTrack: vi.fn(() => false)
}))

vi.mock("@/features/audio/playlistsSelect", () => ({
	selectPlaylists: vi.fn()
}))

vi.mock("@/features/audio/store/usePlaylistTracks.store", () => ({
	default: {
		getState: vi.fn(() => ({ toggleSelectedTrack: vi.fn() })),
		subscribe: vi.fn(() => vi.fn())
	}
}))

vi.mock("@/providers/actionSheet.provider", () => ({
	actionSheet: { show: vi.fn() }
}))

vi.mock("@/hooks/useIsOnline", () => ({
	default: vi.fn(() => true)
}))

vi.mock("@/lib/decryption", () => ({
	driveItemDisplayName: vi.fn(() => "track.mp3")
}))

// React component dependencies that track.tsx imports at the top level
vi.mock("react-native-reorderable-list", () => ({
	useReorderableDrag: vi.fn(() => vi.fn())
}))

vi.mock("react-native-reanimated", () => ({
	FadeIn: {},
	FadeOut: {}
}))

vi.mock("@/features/audio/queries/useAudioMetadata.query", () => ({
	default: vi.fn(() => ({ status: "loading", data: null }))
}))

vi.mock("@/components/ui/audioThumbnail", () => ({
	default: () => null
}))

vi.mock("@/components/ui/view", () => ({
	default: () => null
}))

vi.mock("@/components/ui/text", () => ({
	default: () => null
}))

vi.mock("@/components/ui/pressables", () => ({
	PressableScale: () => null
}))

vi.mock("@/components/ui/checkbox", () => ({
	Checkbox: () => null
}))

vi.mock("@/components/ui/animated", () => ({
	AnimatedView: () => null
}))

vi.mock("react-i18next", () => ({
	useTranslation: vi.fn(() => ({ t: (key: string) => key }))
}))

vi.mock("zustand/shallow", () => ({
	useShallow: vi.fn(fn => fn)
}))

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

import { buildTrackButtons } from "@/features/audio/components/track"
import { type TFunction } from "i18next"
import type { PlaylistWithItems } from "@/features/audio/audio"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const t = ((key: string) => key) as unknown as TFunction

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeFile: any = {
	uuid: "f1",
	name: "track.mp3",
	mime: "audio/mpeg",
	size: BigInt(1000),
	bucket: "b",
	key: "k",
	version: 1,
	chunks: 1,
	region: "de-1",
	playlist: "pl-uuid",
	item: {
		data: {
			uuid: "f1",
			undecryptable: false
		}
	}
}

function makePlaylist(files: PlaylistWithItems["files"] = [fakeFile]): PlaylistWithItems {
	return {
		uuid: "pl-uuid",
		name: "Test Playlist",
		created: 1000,
		updated: 2000,
		files
	}
}

// ---------------------------------------------------------------------------
// Tests — BUG #49: offline gating on add_to_playlist / remove_from_playlist
// ---------------------------------------------------------------------------

describe("buildTrackButtons — offline gating", () => {
	it("add_to_playlist and remove_from_playlist carry disabled:true when offline", () => {
		const playlist = makePlaylist()
		const buttons = buildTrackButtons({ t, track: fakeFile, playlist, isOnline: false })

		const addToPlaylist = buttons.find(b => b.title === "add_to_playlist")
		const removeFromPlaylist = buttons.find(b => b.title === "remove_from_playlist")

		expect(addToPlaylist?.disabled).toBe(true)
		expect(removeFromPlaylist?.disabled).toBe(true)
	})

	it("add_to_playlist and remove_from_playlist carry disabled:false when online", () => {
		const playlist = makePlaylist()
		const buttons = buildTrackButtons({ t, track: fakeFile, playlist, isOnline: true })

		const addToPlaylist = buttons.find(b => b.title === "add_to_playlist")
		const removeFromPlaylist = buttons.find(b => b.title === "remove_from_playlist")

		expect(addToPlaylist?.disabled).toBe(false)
		expect(removeFromPlaylist?.disabled).toBe(false)
	})

	it("select, play, add_to_queue, and close are never disabled when offline", () => {
		const playlist = makePlaylist()
		const buttons = buildTrackButtons({ t, track: fakeFile, playlist, isOnline: false })

		const select = buttons.find(b => b.title === "select")
		const play = buttons.find(b => b.title === "play")
		const addToQueue = buttons.find(b => b.title === "add_to_queue")
		const close = buttons.find(b => b.cancel === true)

		expect(select?.disabled).toBeFalsy()
		expect(play?.disabled).toBeFalsy()
		expect(addToQueue?.disabled).toBeFalsy()
		expect(close?.disabled).toBeFalsy()
	})
})
