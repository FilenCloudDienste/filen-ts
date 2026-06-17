import { vi, describe, it, expect } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

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

vi.mock("@/components/ui/menu", () => ({
	default: () => null
}))

vi.mock("@/components/ui/ellipsisMenuTrigger", () => ({
	default: () => null
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

import { buildTrackButtons, buildUndecryptableTrackButtons } from "@/features/audio/components/track"
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
// Tests — BUG #49 (offline gating), migrated to the Menu contract:
// the builders now return MenuButton[] where offline gating is declared via
// requiresOnline:true (resolved to disabled by MenuInner.applyOfflineGate)
// instead of an inline disabled:!isOnline computed from a builder param.
// ---------------------------------------------------------------------------

describe("buildTrackButtons — Menu contract", () => {
	it("add_to_playlist and remove_from_playlist carry requiresOnline:true for the Menu offline gate", () => {
		const playlist = makePlaylist()
		const buttons = buildTrackButtons({ t, track: fakeFile, playlist })

		const addToPlaylist = buttons.find(b => b.id === "addToPlaylist")
		const removeFromPlaylist = buttons.find(b => b.id === "removeFromPlaylist")

		expect(addToPlaylist?.requiresOnline).toBe(true)
		expect(removeFromPlaylist?.requiresOnline).toBe(true)
	})

	it("remove_from_playlist is destructive", () => {
		const playlist = makePlaylist()
		const buttons = buildTrackButtons({ t, track: fakeFile, playlist })

		const removeFromPlaylist = buttons.find(b => b.id === "removeFromPlaylist")

		expect(removeFromPlaylist?.destructive).toBe(true)
	})

	it("select, play and add_to_queue are never offline-gated and never pre-disabled", () => {
		const playlist = makePlaylist()
		const buttons = buildTrackButtons({ t, track: fakeFile, playlist })

		const select = buttons.find(b => b.id === "select")
		const play = buttons.find(b => b.id === "play")
		const addToQueue = buttons.find(b => b.id === "addToQueue")

		expect(select?.requiresOnline).toBeFalsy()
		expect(select?.disabled).toBeFalsy()
		expect(play?.requiresOnline).toBeFalsy()
		expect(play?.disabled).toBeFalsy()
		expect(addToQueue?.requiresOnline).toBeFalsy()
		expect(addToQueue?.disabled).toBeFalsy()
	})

	it("has no close/cancel item (native menus dismiss on outside tap) and unique ids", () => {
		const playlist = makePlaylist()
		const buttons = buildTrackButtons({ t, track: fakeFile, playlist })

		expect(buttons.some(b => b.id === "close" || b.title === "close")).toBe(false)
		expect(new Set(buttons.map(b => b.id)).size).toBe(buttons.length)
	})
})

describe("buildUndecryptableTrackButtons — Menu contract", () => {
	it("offers only select and the destructive, offline-gated remove_from_playlist", () => {
		const playlist = makePlaylist()
		const buttons = buildUndecryptableTrackButtons({ t, track: fakeFile, playlist })

		const ids = buttons.map(b => b.id)
		const removeFromPlaylist = buttons.find(b => b.id === "removeFromPlaylist")

		expect(ids).toContain("select")
		expect(ids).toContain("removeFromPlaylist")
		expect(ids).not.toContain("play")
		expect(ids).not.toContain("addToQueue")
		expect(ids).not.toContain("addToPlaylist")
		expect(buttons.some(b => b.id === "close" || b.title === "close")).toBe(false)
		expect(removeFromPlaylist?.destructive).toBe(true)
		expect(removeFromPlaylist?.requiresOnline).toBe(true)
	})
})
