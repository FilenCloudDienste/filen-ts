import { vi, describe, it, expect } from "vitest"

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import of the module under test
// ---------------------------------------------------------------------------

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))
vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

vi.mock("expo-router", () => ({
	router: { push: vi.fn(), back: vi.fn() }
}))

vi.mock("@/lib/alerts", () => ({
	default: { error: vi.fn(), normal: vi.fn() }
}))

vi.mock("@/lib/prompts", () => ({
	default: { alert: vi.fn(), input: vi.fn() }
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
		clearQueue: vi.fn(),
		replaceQueue: vi.fn(),
		play: vi.fn(),
		addToQueue: vi.fn(),
		getQueue: vi.fn(() => []),
		renamePlaylist: vi.fn(),
		deletePlaylist: vi.fn(),
		addFilesToPlaylist: vi.fn(),
		savePlaylist: vi.fn()
	},
	useAudioQueue: vi.fn(() => ({ queueItem: null }))
}))

vi.mock("@/features/drive/screens/driveSelect", () => ({
	selectDriveItems: vi.fn()
}))

vi.mock("@/features/audio/store/usePlaylists.store", () => ({
	default: {
		getState: vi.fn(() => ({ toggleSelectedPlaylist: vi.fn() })),
		subscribe: vi.fn(() => vi.fn())
	}
}))

vi.mock("@/providers/actionSheet.provider", () => ({
	actionSheet: { show: vi.fn() }
}))

vi.mock("@/hooks/useIsOnline", () => ({
	default: vi.fn(() => true)
}))

// React component dependencies that playlistRow.tsx imports at the top level
vi.mock("uniwind", () => ({
	useResolveClassNames: vi.fn(() => ({})),
	useUniwind: vi.fn(() => ({ theme: "dark" }))
}))

vi.mock("@expo/vector-icons/Ionicons", () => ({
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

vi.mock("@/lib/time", () => ({
	simpleDateNoTime: vi.fn(() => "2024-01-01")
}))

vi.mock("@/components/ui/checkbox", () => ({
	Checkbox: () => null
}))

vi.mock("react-i18next", () => ({
	useTranslation: vi.fn(() => ({ t: (key: string) => key }))
}))

vi.mock("@/features/audio/playlistsSelect", () => ({
	selectPlaylists: vi.fn()
}))

vi.mock("zustand/shallow", () => ({
	useShallow: vi.fn(fn => fn)
}))

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

import { buildPlaylistRowButtons } from "@/features/audio/components/playlistRow"
import { type TFunction } from "i18next"
import type { PlaylistWithItems } from "@/features/audio/audio"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const t = ((key: string) => key) as unknown as TFunction

function makePlaylist(): PlaylistWithItems {
	return {
		uuid: "pl-uuid",
		name: "Test Playlist",
		created: 1000,
		updated: 2000,
		files: []
	}
}

// ---------------------------------------------------------------------------
// Tests — BUG #20: offline gating on rename / add_tracks / delete
// ---------------------------------------------------------------------------

describe("buildPlaylistRowButtons — offline gating", () => {
	it("rename, add_tracks, delete carry disabled:true when isOnline is false", () => {
		const playlist = makePlaylist()
		const buttons = buildPlaylistRowButtons({ t, playlist, isOnline: false })

		const rename = buttons.find(b => b.title === "rename")
		const addTracks = buttons.find(b => b.title === "add_tracks")
		const deleteBtn = buttons.find(b => b.title === "delete")

		expect(rename?.disabled).toBe(true)
		expect(addTracks?.disabled).toBe(true)
		expect(deleteBtn?.disabled).toBe(true)
	})

	it("rename, add_tracks, delete carry disabled:false when isOnline is true", () => {
		const playlist = makePlaylist()
		const buttons = buildPlaylistRowButtons({ t, playlist, isOnline: true })

		const rename = buttons.find(b => b.title === "rename")
		const addTracks = buttons.find(b => b.title === "add_tracks")
		const deleteBtn = buttons.find(b => b.title === "delete")

		expect(rename?.disabled).toBe(false)
		expect(addTracks?.disabled).toBe(false)
		expect(deleteBtn?.disabled).toBe(false)
	})

	it("select and close buttons are never disabled when offline", () => {
		const playlist = makePlaylist()
		const buttons = buildPlaylistRowButtons({ t, playlist, isOnline: false })

		const select = buttons.find(b => b.title === "select")
		const close = buttons.find(b => b.cancel === true)

		expect(select?.disabled).toBeFalsy()
		expect(close?.disabled).toBeFalsy()
	})

	it("play and add_to_queue are never disabled when offline (playlist has files)", () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const fakeFile: any = {
			uuid: "f1",
			name: "track.mp3",
			mime: "audio/mpeg",
			size: 1000,
			bucket: "b",
			key: "k",
			version: 1,
			chunks: 1,
			region: "de-1",
			playlist: "pl-uuid",
			item: {}
		}
		const playlist: PlaylistWithItems = { ...makePlaylist(), files: [fakeFile] }
		const buttons = buildPlaylistRowButtons({ t, playlist, isOnline: false })

		const play = buttons.find(b => b.title === "play")
		const addToQueue = buttons.find(b => b.title === "add_to_queue")

		expect(play?.disabled).toBeFalsy()
		expect(addToQueue?.disabled).toBeFalsy()
	})
})
