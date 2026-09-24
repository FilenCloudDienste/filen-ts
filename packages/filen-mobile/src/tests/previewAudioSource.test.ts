// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"
import { createElement } from "react"
import { render, cleanup } from "@testing-library/react"

const { mockUseAudioMetadataQuery, mockUseFileUrlQuery, mockUseAudioPlayer, onlineHolder } = vi.hoisted(() => ({
	mockUseAudioMetadataQuery: vi.fn(),
	mockUseFileUrlQuery: vi.fn(),
	mockUseAudioPlayer: vi.fn(() => ({})),
	onlineHolder: { online: true }
}))

// Any stub component renders its children; enough for the real PreviewAudio tree to mount.
async function passthrough(testId?: string) {
	const { createElement: h } = await import("react")

	return (props: { children?: unknown }) => h("div", testId ? { "data-testid": testId } : null, props.children as never)
}

vi.mock("react-native", async () => {
	const actual = await import("@/tests/mocks/reactNative")

	return {
		...actual,
		useWindowDimensions: () => ({ width: 400, height: 800, scale: 2, fontScale: 1 }),
		ActivityIndicator: await passthrough("spinner")
	}
})
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock("@/components/ui/view", async () => ({ default: await passthrough() }))
vi.mock("@/components/ui/animated", async () => ({ AnimatedView: await passthrough() }))
vi.mock("@/components/ui/text", async () => ({ default: await passthrough() }))
vi.mock("@/components/ui/pressables", async () => ({ PressableScale: await passthrough() }))
vi.mock("@/components/ui/image", async () => ({ ImageBackground: await passthrough(), Image: await passthrough() }))
vi.mock("@expo/vector-icons/Ionicons", async () => ({ default: await passthrough() }))
vi.mock("uniwind", () => ({ useResolveClassNames: () => ({ color: "#fff" }) }))
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }))
vi.mock("react-native-gesture-handler", async () => {
	// Every builder method returns the builder, whatever the chain.
	const chain: Record<string, unknown> = new Proxy({}, { get: () => () => chain })

	return {
		Gesture: chain,
		GestureDetector: await passthrough()
	}
})
vi.mock("react-native-reanimated", () => ({
	useSharedValue: (value: unknown) => ({ value }),
	useAnimatedStyle: () => ({}),
	useDerivedValue: (fn: () => unknown) => ({ value: fn() }),
	withSpring: (value: unknown) => value
}))
vi.mock("react-native-worklets", () => ({ runOnJS: (fn: unknown) => fn }))
vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))
vi.mock("expo-audio", () => ({
	useAudioPlayer: mockUseAudioPlayer,
	useAudioPlayerStatus: () => ({ isLoaded: true, isBuffering: false, playing: false, currentTime: 0, duration: 10 })
}))
vi.mock("@/features/audio/audio", () => ({ default: { setAudioMode: vi.fn(), pause: vi.fn() } }))
vi.mock("@/features/audio/queries/useAudioMetadata.query", () => ({ default: mockUseAudioMetadataQuery }))
vi.mock("@/queries/useFileUrl.query", () => ({ default: mockUseFileUrlQuery }))
vi.mock("@/hooks/useIsOnline", () => ({ default: () => onlineHolder.online }))
vi.mock("@/lib/decryption", () => ({ driveItemDisplayName: () => "song.mp3" }))
vi.mock("@/components/drivePreview/gallery", () => ({ galleryItemKey: () => "song-uuid" }))
vi.mock("@/components/drivePreview/unavailableOfflineNotice", async () => ({ default: await passthrough("offline-notice") }))
vi.mock("@filen/shared", async () => ({
	...(await import("@/tests/mocks/filenShared")),
	formatSecondsToMediaClock: () => "0:00"
}))

import PreviewAudio from "@/components/drivePreview/previewAudio"

const item = {
	type: "drive",
	data: {
		type: "file",
		data: { uuid: "song-uuid", size: 1n, decryptedMeta: { name: "song.mp3" } }
	}
} as never

function renderAudio() {
	return render(createElement(PreviewAudio, { item }))
}

beforeEach(() => {
	cleanup()
	onlineHolder.online = true
	mockUseAudioPlayer.mockClear()
	mockUseAudioMetadataQuery.mockReset()
	mockUseFileUrlQuery.mockReset()
	mockUseFileUrlQuery.mockImplementation((_source: unknown, options: { enabled: boolean }) =>
		options.enabled
			? { status: "success", fetchStatus: "idle", data: "file:///cache/song.mp3" }
			: { status: "pending", fetchStatus: "idle" }
	)
})

describe("PreviewAudio — playback source", () => {
	it("holds the URL lookup until the tags are read (which pulls the file local)", () => {
		mockUseAudioMetadataQuery.mockReturnValue({ status: "pending", fetchStatus: "fetching" })

		const { getByTestId } = renderAudio()

		expect(mockUseFileUrlQuery).toHaveBeenCalledWith(expect.objectContaining({ type: "drive" }), { enabled: false })
		expect(getByTestId("spinner")).toBeTruthy()
		expect(mockUseAudioPlayer).not.toHaveBeenCalled()
	})

	it("then plays the URL resolved after the tags, i.e. the file-cache copy", () => {
		mockUseAudioMetadataQuery.mockReturnValue({ status: "success", fetchStatus: "idle", data: null })

		renderAudio()

		expect(mockUseFileUrlQuery).toHaveBeenCalledWith(expect.objectContaining({ type: "drive" }), { enabled: true })
		expect(mockUseAudioPlayer).toHaveBeenCalled()

		for (const [source] of mockUseAudioPlayer.mock.calls as unknown as [string][]) {
			expect(source).toBe("file:///cache/song.mp3")
		}
	})

	it("shows the offline notice when the tags can't be read offline", () => {
		onlineHolder.online = false
		mockUseAudioMetadataQuery.mockReturnValue({ status: "error", fetchStatus: "idle" })

		const { getByTestId } = renderAudio()

		expect(getByTestId("offline-notice")).toBeTruthy()
		expect(mockUseAudioPlayer).not.toHaveBeenCalled()
	})

	it("shows the offline notice when the tags are cached but the bytes are not reachable", () => {
		mockUseAudioMetadataQuery.mockReturnValue({ status: "success", fetchStatus: "idle", data: null })
		mockUseFileUrlQuery.mockReturnValue({ status: "success", fetchStatus: "idle", data: null })

		const { getByTestId } = renderAudio()

		expect(getByTestId("offline-notice")).toBeTruthy()
		expect(mockUseAudioPlayer).not.toHaveBeenCalled()
	})
})
