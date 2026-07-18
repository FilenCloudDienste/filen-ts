import { vi, describe, it, expect } from "vitest"
vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

// ─── Module boundary mocks ───────────────────────────────────────────────────
// gallery.tsx imports many native/heavy modules; stub them all so the pure
// galleryItemKey export can be loaded in a node vitest environment.

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (k: string) => k })
}))

vi.mock("expo-router", () => ({
	router: { canGoBack: vi.fn(() => false), back: vi.fn() }
}))

vi.mock("react-native-edge-to-edge", () => ({
	SystemBars: () => null
}))

vi.mock("expo-screen-orientation", () => ({
	Orientation: {
		PORTRAIT_UP: 1,
		PORTRAIT_DOWN: 2,
		LANDSCAPE_LEFT: 3,
		LANDSCAPE_RIGHT: 4
	},
	OrientationLock: {
		PORTRAIT_UP: "PORTRAIT_UP",
		PORTRAIT_DOWN: "PORTRAIT_DOWN",
		LANDSCAPE_LEFT: "LANDSCAPE_LEFT",
		LANDSCAPE_RIGHT: "LANDSCAPE_RIGHT"
	},
	getOrientationAsync: vi.fn(),
	lockAsync: vi.fn(),
	unlockAsync: vi.fn()
}))

vi.mock("react-native-gesture-handler", () => ({
	GestureDetector: () => null,
	Gesture: {
		Pan: () => ({
			manualActivation: () => ({
				onTouchesDown: () => ({
					onTouchesMove: () => ({ onStart: () => ({ onUpdate: () => ({ onEnd: () => ({ enabled: vi.fn() }) }) }) })
				})
			})
		})
	}
}))

vi.mock("react-native-reanimated", () => ({
	useSharedValue: (v: unknown) => ({ value: v }),
	useAnimatedStyle: (fn: () => unknown) => fn,
	withSpring: (v: unknown) => v,
	runOnUI: (fn: unknown) => fn,
	interpolate: (v: unknown) => v,
	Extrapolation: {
		CLAMP: "clamp",
		EXTEND: "extend",
		IDENTITY: "identity"
	}
}))

vi.mock("react-native-worklets", () => ({
	runOnJS: (fn: unknown) => fn
}))

vi.mock("@shopify/flash-list", () => ({
	FlashList: () => null
}))

vi.mock("@/components/ui/view", () => ({
	default: () => null
}))

vi.mock("@/components/ui/animated", () => ({
	AnimatedView: () => null
}))

vi.mock("@/components/ui/listEmpty", () => ({
	default: () => null
}))

vi.mock("@/components/ui/button", () => ({
	default: () => null
}))

vi.mock("@/components/drivePreview/header", () => ({
	default: () => null
}))

vi.mock("@/components/drivePreview/galleryItem", () => ({
	default: () => null
}))

vi.mock("@/components/drivePreview/galleryVideoPlayers", () => ({
	default: {
		acquire: vi.fn(),
		pauseAllExcept: vi.fn(),
		releaseAll: vi.fn()
	}
}))

vi.mock("@/stores/useDrivePreview.store", () => ({
	default: vi.fn(() => ({}))
}))

vi.mock("@/lib/previewType", () => ({
	getPreviewType: vi.fn(() => "image"),
	isImagePreviewType: (previewType: string) => previewType === "image" || previewType === "svg"
}))

vi.mock("@/lib/decryption", () => ({
	driveItemDisplayName: vi.fn((item: unknown) => String(item))
}))

vi.mock("zustand/shallow", () => ({
	useShallow: (fn: unknown) => fn
}))

// ─── Actual import ───────────────────────────────────────────────────────────

import { galleryItemKey, type GalleryItemTagged } from "@/components/drivePreview/gallery"

// ─── #81: galleryItemKey type-discriminated key builder ──────────────────────

describe("galleryItemKey", () => {
	it("returns item.data.data.uuid for a drive item", () => {
		const item: GalleryItemTagged = {
			type: "drive",
			data: {
				type: "file",
				data: {
					uuid: "abc-123"
				}
			} as unknown as Extract<GalleryItemTagged, { type: "drive" }>["data"]
		}

		expect(galleryItemKey(item)).toBe("abc-123")
	})

	it("returns item.data.url for an external item", () => {
		const item: GalleryItemTagged = {
			type: "external",
			data: {
				name: "photo.jpg",
				url: "https://example.com/photo.jpg"
			}
		}

		expect(galleryItemKey(item)).toBe("https://example.com/photo.jpg")
	})

	it("returns uuid of a sharedFile drive item", () => {
		const item: GalleryItemTagged = {
			type: "drive",
			data: {
				type: "sharedFile",
				data: {
					uuid: "shared-uuid-999"
				}
			} as unknown as Extract<GalleryItemTagged, { type: "drive" }>["data"]
		}

		expect(galleryItemKey(item)).toBe("shared-uuid-999")
	})

	it("returns url for an external item with a URL that contains special characters", () => {
		const url = "https://cdn.example.com/files/my%20photo.jpg?token=xyz&expires=999"

		const item: GalleryItemTagged = {
			type: "external",
			data: {
				name: "my photo.jpg",
				url
			}
		}

		expect(galleryItemKey(item)).toBe(url)
	})
})
