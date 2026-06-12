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

vi.mock("@/components/ui/menu", () => ({
	default: () => null
}))

// React component dependencies that playlistRow.tsx imports at the top level
vi.mock("uniwind", () => ({
	useResolveClassNames: vi.fn(() => ({})),
	useUniwind: vi.fn(() => ({ theme: "dark" }))
}))

vi.mock("@/lib/hairline", () => ({
	hairlineBorderBottom: {}
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
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests — BUG #20 (offline gating), migrated to the Menu contract:
// the builder now returns MenuButton[] where offline gating is declared via
// requiresOnline:true (resolved to disabled by MenuInner.applyOfflineGate)
// instead of an inline disabled:!isOnline computed from a builder param.
// ---------------------------------------------------------------------------

describe("buildPlaylistRowButtons — Menu contract", () => {
	it("rename, add_tracks and delete carry requiresOnline:true for the Menu offline gate", () => {
		const playlist = makePlaylist()
		const buttons = buildPlaylistRowButtons({ t, playlist })

		const rename = buttons.find(b => b.id === "rename")
		const addTracks = buttons.find(b => b.id === "addTracks")
		const deleteBtn = buttons.find(b => b.id === "delete")

		expect(rename?.requiresOnline).toBe(true)
		expect(addTracks?.requiresOnline).toBe(true)
		expect(deleteBtn?.requiresOnline).toBe(true)
	})

	it("delete is destructive", () => {
		const playlist = makePlaylist()
		const buttons = buildPlaylistRowButtons({ t, playlist })

		const deleteBtn = buttons.find(b => b.id === "delete")

		expect(deleteBtn?.destructive).toBe(true)
	})

	it("select is never offline-gated and there is no close/cancel item", () => {
		const playlist = makePlaylist()
		const buttons = buildPlaylistRowButtons({ t, playlist })

		const select = buttons.find(b => b.id === "select")

		expect(select?.requiresOnline).toBeFalsy()
		expect(select?.disabled).toBeFalsy()
		expect(buttons.some(b => b.id === "close" || b.title === "close")).toBe(false)
		expect(new Set(buttons.map(b => b.id)).size).toBe(buttons.length)
	})

	it("play and add_to_queue are present and never offline-gated when the playlist has tracks", () => {
		const playlist: PlaylistWithItems = { ...makePlaylist(), files: [fakeFile] }
		const buttons = buildPlaylistRowButtons({ t, playlist })

		const play = buttons.find(b => b.id === "play")
		const addToQueue = buttons.find(b => b.id === "addToQueue")

		expect(play).toBeDefined()
		expect(addToQueue).toBeDefined()
		expect(play?.requiresOnline).toBeFalsy()
		expect(play?.disabled).toBeFalsy()
		expect(addToQueue?.requiresOnline).toBeFalsy()
		expect(addToQueue?.disabled).toBeFalsy()
	})

	it("play and add_to_queue are omitted when the playlist is empty", () => {
		const playlist = makePlaylist()
		const buttons = buildPlaylistRowButtons({ t, playlist })

		expect(buttons.some(b => b.id === "play")).toBe(false)
		expect(buttons.some(b => b.id === "addToQueue")).toBe(false)
	})
})
