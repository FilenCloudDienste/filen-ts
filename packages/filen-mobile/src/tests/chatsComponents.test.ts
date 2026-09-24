import { vi, describe, it, expect, beforeEach } from "vitest"

// ─── Module boundary mocks (must be top-level vi.mock calls, hoisted by Vitest) ─

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

// @filen/sdk-rs loads a wasm worker that references the browser `self` global —
// mock it out so the node test env can load our source modules.
vi.mock("@filen/sdk-rs", () => ({
	ChatTypingType: { Up: 0, Down: 1 }
}))

// regexed.tsx's Mention component resolves display names through contactDisplayName, and now also
// consumes segmentMessage/isEmojiOnly directly (both already pulled through actual in the shared mock
// factory below) — pulled through from the real module rather than reimplemented here since they're
// pure, platform-free logic.
vi.mock("@filen/shared", async () => ({
	...(await import("@/tests/mocks/filenShared")),
	parseNumbersFromString(s: unknown) {
		const digits = (s as string).replace(/\D/g, "")
		const n = parseInt(digits, 10)
		return isNaN(n) ? 0 : n
	},
	fastLocaleCompare(a: unknown, b: unknown) {
		return (a as string).localeCompare(b as string)
	},
	cn(...args: unknown[]) {
		return args.filter(Boolean).join(" ")
	},
	contactDisplayName: (await vi.importActual<typeof import("@filen/shared")>("@filen/shared")).contactDisplayName
}))

// ── UI components — not under test, render nothing ──────────────────────────
vi.mock("@/components/ui/text", () => ({ default: () => null, Text: () => null }))
vi.mock("@/components/ui/view", () => ({
	default: () => null,
	KeyboardStickyView: () => null,
	CrossGlassContainerView: () => null,
	GestureHandlerScrollView: () => null
}))
vi.mock("@/components/ui/image", () => ({ default: () => null }))
vi.mock("@/components/ui/pressables", () => ({ PressableScale: () => null }))
vi.mock("@/components/ui/animated", () => ({ AnimatedView: () => null }))
vi.mock("@/components/ui/avatar", () => ({ default: () => null }))
vi.mock("@/components/ui/menu", () => ({ default: () => null }))
vi.mock("@/components/ui/fullScreenLoadingModal", () => ({
	runWithLoading: vi.fn()
}))

// ── RN ecosystem ─────────────────────────────────────────────────────────────
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (k: string) => k })
}))
vi.mock("expo-linking", () => ({ canOpenURL: vi.fn(), openURL: vi.fn() }))
vi.mock("expo-router", () => ({
	router: { push: vi.fn(), back: vi.fn(), canGoBack: vi.fn().mockReturnValue(true) }
}))
vi.mock("zustand/shallow", () => ({
	useShallow: (fn: unknown) => fn
}))
vi.mock("react-native-reanimated", () => ({
	FadeIn: {},
	FadeOut: {},
	SlideInDown: {},
	SlideOutDown: {},
	useAnimatedStyle: () => ({}),
	interpolate: () => 0
}))
vi.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ bottom: 0, top: 0, left: 0, right: 0 })
}))
vi.mock("@shopify/flash-list", () => ({
	useMappingHelper: () => ({ getMappingKey: (k: string) => k }),
	useRecyclingState: (init: unknown) => [init, vi.fn()]
}))
vi.mock("expo-video", () => ({
	useVideoPlayer: vi.fn(),
	VideoView: () => null
}))
vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))
vi.mock("react-native-keyboard-controller", () => ({
	useReanimatedKeyboardAnimation: () => ({ progress: { value: 0 } })
}))
vi.mock("uniwind", () => ({
	useResolveClassNames: () => ({ color: "#fff" })
}))
vi.mock("@tanstack/react-query", () => ({
	onlineManager: { isOnline: () => true }
}))
vi.mock("@/lib/documentPicker", () => ({ pickDocuments: vi.fn() }))
vi.mock("expo-image-picker", () => ({
	launchImageLibraryAsync: vi.fn(),
	launchCameraAsync: vi.fn(),
	UIImagePickerPresentationStyle: { PAGE_SHEET: "pageSheet" }
}))
vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: () => null }))

// ── Internal lib mocks ────────────────────────────────────────────────────────
vi.mock("@/lib/auth", () => ({
	useStringifiedClient: vi.fn(),
	useSdkClients: vi.fn()
}))
vi.mock("@/lib/alerts", async () => await import("@/tests/mocks/alerts"))
vi.mock("@/lib/prompts", () => ({
	default: { alert: vi.fn(), input: vi.fn() }
}))
vi.mock("@/features/chats/chats", () => ({
	default: {
		mute: vi.fn(),
		delete: vi.fn(),
		leave: vi.fn(),
		rename: vi.fn(),
		updateLastFocusTimesNow: vi.fn(),
		markRead: vi.fn(),
		sendTyping: vi.fn(),
		getChatUploadsDirectory: vi.fn()
	}
}))
vi.mock("@/lib/secureStore", () => ({
	useSecureStore: () => ["", vi.fn()]
}))
vi.mock("@/lib/events", () => ({
	default: {
		subscribe: vi.fn(() => ({ remove: vi.fn() })),
		emit: vi.fn()
	}
}))
vi.mock("@/features/transfers/transfers", () => ({ default: { upload: vi.fn() } }))
vi.mock("@/features/drive/drive", () => ({
	default: {
		enablePublicLink: vi.fn(),
		openLinkedDirectory: vi.fn(),
		openLinkedFile: vi.fn()
	}
}))
vi.mock("@/lib/i18n", () => ({
	default: { t: (k: string) => k },
	t: (k: string) => k
}))
vi.mock("@/lib/decryption", () => ({
	messageDisplayBody: (m: unknown) => (m as { inner: { message?: string } }).inner?.message ?? "",
	chatDisplayName: (chat: unknown, userId: bigint) => {
		const c = chat as { name?: string; participants: { userId: bigint; email: string }[]; uuid: string }
		if (c.name) return c.name
		const other = c.participants.find(p => p.userId !== userId)
		return other?.email ?? c.uuid
	},
	cannotDecryptPlaceholder: (uuid: string) => `cannot_decrypt_${uuid}`
}))

vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapFileMeta: vi.fn(),
	unwrappedFileIntoDriveItem: vi.fn(),
	makeDriveItemPublicLink: vi.fn(),
	linkedFileIntoDriveItem: vi.fn()
}))

vi.mock("@/lib/cache", () => ({
	default: {
		chatAttachmentLayouts: { get: () => null, set: vi.fn() },
		uuidToAnyDriveItem: { set: vi.fn() }
	}
}))

// ── Stores ────────────────────────────────────────────────────────────────────
vi.mock("@/features/chats/store/useChats.store", () => {
	// Callable as a hook AND carrying getState (the chat input's module-level
	// flushInflightMessagesWithAlert helper reads the store imperatively).
	const hook = Object.assign(
		vi.fn(() => ({})),
		{
			getState: vi.fn(() => ({ inflightMessages: {} }))
		}
	)

	return {
		default: hook,
		useChatsStore: hook
	}
})
vi.mock("@/stores/useApp.store", () => ({
	default: {
		getState: vi.fn(() => ({ pathname: "/" })),
		selectedChats: []
	}
}))
vi.mock("@/stores/useDrivePreview.store", () => ({
	default: { getState: vi.fn(() => ({ open: vi.fn() })) }
}))
vi.mock("@/stores/useHttp.store", () => ({
	default: vi.fn(() => ({}))
}))

// ── Queries ───────────────────────────────────────────────────────────────────
vi.mock("@/features/chats/queries/useChatMessages.query", () => ({
	chatMessagesQueryUpdate: vi.fn(),
	default: vi.fn(() => ({ status: "pending" }))
}))
vi.mock("@/features/chats/queries/useChatMessageLinks.query", () => ({
	default: vi.fn(() => ({ status: "pending" }))
}))
vi.mock("@/queries/useAccount.query", () => ({
	default: vi.fn(() => ({ status: "pending" }))
}))

// ── Custom hooks ──────────────────────────────────────────────────────────────
vi.mock("@/hooks/useViewLayout", () => ({
	default: vi.fn(() => ({ layout: { width: 375, height: 812 }, onLayout: vi.fn() }))
}))
vi.mock("@/hooks/useIsOnline", () => ({ default: vi.fn(() => true) }))
vi.mock("@/hooks/useEffectOnce", () => ({ default: vi.fn() }))
vi.mock("@/features/chats/hooks/useChatUnreadCount", () => ({ default: vi.fn(() => 0) }))
vi.mock("@/hooks/useMediaPermissions", () => ({
	default: vi.fn(() => ({ loading: false, granted: true })),
	hasAllNeededMediaPermissions: vi.fn().mockResolvedValue(true)
}))

// ── Other component deps ──────────────────────────────────────────────────────
vi.mock("@/features/chats/components/sync", () => ({
	sync: { flushToDisk: vi.fn(), syncNow: vi.fn() }
}))
vi.mock("@/components/ui/virtualList", () => ({ default: () => null }))
vi.mock("@/components/ui/listEmpty", () => ({ default: () => null }))
vi.mock("@/components/itemIcons", () => ({
	FileIcon: () => null,
	DirectoryIcon: () => null
}))
// NOTE: do NOT mock @/features/chats/components/chat/message/regexed — we test its exports directly.
vi.mock("@/features/chats/components/chat/message/menu", () => ({ default: () => null }))
vi.mock("@/features/drive/driveSelectSession", () => ({ selectDriveItems: vi.fn() }))
vi.mock("@/lib/serializer", () => ({ serialize: vi.fn(x => JSON.stringify(x)) }))
// chat/input subcomponents + the system-presentation wrapper — not under test, the input
// module is imported only for its flushInflightMessagesWithAlert helper (M3).
vi.mock("@/features/chats/components/chat/input/mentionSuggestions", () => ({ default: () => null }))
vi.mock("@/features/chats/components/chat/input/emojiSuggestions", () => ({ default: () => null }))
vi.mock("@/features/chats/components/chat/input/replyTo", () => ({ default: () => null }))
vi.mock("@/lib/systemPresentation", () => ({
	withSystemPresentation: vi.fn(async (fn: () => Promise<unknown>) => await fn())
}))

// ─── Actual imports ───────────────────────────────────────────────────────────

import { customEmojisSet } from "@/features/chats/components/chat/message/regexed"

import { createMenuButtons } from "@/features/chats/components/list/chat/menu"
import { flushInflightMessagesWithAlert } from "@/features/chats/components/chat/input"
import { sync } from "@/features/chats/components/sync"
import alerts from "@/lib/alerts"
import type { Chat } from "@/types"

// ─── Factory helpers ──────────────────────────────────────────────────────────

function makeChat(overrides: Partial<Chat> = {}): Chat {
	return {
		uuid: "chat-abc-123",
		ownerId: 1n,
		muted: false,
		participants: [],
		undecryptable: false,
		key: "key",
		created: 0n,
		lastFocus: 0n,
		...overrides
	} as Chat
}

// ─── customEmojisSet ─────────────────────────────────────────────────────────

describe("customEmojisSet", () => {
	it("contains known emoji ids (gigachad, catjam)", () => {
		expect(customEmojisSet.has("gigachad")).toBe(true)
		expect(customEmojisSet.has("catjam")).toBe(true)
	})

	it("does NOT contain a fabricated id", () => {
		expect(customEmojisSet.has("nonexistent_emoji_abc123")).toBe(false)
	})

	it("is a Set instance", () => {
		expect(customEmojisSet).toBeInstanceOf(Set)
	})
})

// ─── createMenuButtons ────────────────────────────────────────────────────────

describe("createMenuButtons", () => {
	describe("undecryptable chats", () => {
		it("owner + origin=chats: returns exactly [select, delete]", () => {
			const chat = makeChat({ undecryptable: true, ownerId: 42n })
			const buttons = createMenuButtons({ chat, userId: 42n, origin: "chats", unreadCount: 0 })
			const ids = buttons.map(b => b.id)
			expect(ids).toContain("select")
			expect(ids).toContain("delete")
			expect(ids).not.toContain("leave")
			expect(ids).not.toContain("markAsRead")
			expect(ids).not.toContain("editName")
			expect(buttons).toHaveLength(2)
		})

		it("non-owner + origin=chats: returns exactly [select, leave]", () => {
			const chat = makeChat({ undecryptable: true, ownerId: 99n })
			const buttons = createMenuButtons({ chat, userId: 42n, origin: "chats", unreadCount: 0 })
			const ids = buttons.map(b => b.id)
			expect(ids).toContain("select")
			expect(ids).toContain("leave")
			expect(ids).not.toContain("delete")
			expect(buttons).toHaveLength(2)
		})

		it("origin=chat with owner undecryptable: no select/deselect but has delete", () => {
			const chat = makeChat({ undecryptable: true, ownerId: 42n })
			const buttons = createMenuButtons({ chat, userId: 42n, origin: "chat", unreadCount: 0 })
			const ids = buttons.map(b => b.id)
			expect(ids).not.toContain("select")
			expect(ids).not.toContain("deselect")
			expect(ids).toContain("delete")
		})

		it("origin=chat with non-owner undecryptable: no select/deselect, has leave", () => {
			const chat = makeChat({ undecryptable: true, ownerId: 99n })
			const buttons = createMenuButtons({ chat, userId: 42n, origin: "chat", unreadCount: 0 })
			const ids = buttons.map(b => b.id)
			expect(ids).not.toContain("select")
			expect(ids).not.toContain("deselect")
			expect(ids).toContain("leave")
		})

		it("undecryptable with unreadCount > 0: no markAsRead button (only exists in decryptable path)", () => {
			const chat = makeChat({ undecryptable: true, ownerId: 99n })
			const buttons = createMenuButtons({ chat, userId: 42n, origin: "chats", unreadCount: 5 })
			const ids = buttons.map(b => b.id)
			expect(ids).not.toContain("markAsRead")
		})
	})

	describe("decryptable chats", () => {
		it("owner: contains editName and delete buttons", () => {
			const chat = makeChat({ undecryptable: false, ownerId: 42n })
			const buttons = createMenuButtons({ chat, userId: 42n, origin: "chats", unreadCount: 0 })
			const ids = buttons.map(b => b.id)
			expect(ids).toContain("editName")
			expect(ids).toContain("delete")
		})

		it("owner: does NOT contain leave button", () => {
			const chat = makeChat({ undecryptable: false, ownerId: 42n })
			const buttons = createMenuButtons({ chat, userId: 42n, origin: "chats", unreadCount: 0 })
			const ids = buttons.map(b => b.id)
			expect(ids).not.toContain("leave")
		})

		it("non-owner: contains leave button", () => {
			const chat = makeChat({ undecryptable: false, ownerId: 99n })
			const buttons = createMenuButtons({ chat, userId: 42n, origin: "chats", unreadCount: 0 })
			const ids = buttons.map(b => b.id)
			expect(ids).toContain("leave")
		})

		it("non-owner: does NOT contain delete button", () => {
			const chat = makeChat({ undecryptable: false, ownerId: 99n })
			const buttons = createMenuButtons({ chat, userId: 42n, origin: "chats", unreadCount: 0 })
			const ids = buttons.map(b => b.id)
			expect(ids).not.toContain("delete")
		})

		it("origin=chat: no select button emitted for owner", () => {
			const chat = makeChat({ undecryptable: false, ownerId: 42n })
			const buttons = createMenuButtons({ chat, userId: 42n, origin: "chat", unreadCount: 0 })
			const ids = buttons.map(b => b.id)
			expect(ids).not.toContain("select")
			expect(ids).not.toContain("deselect")
		})

		it("origin=chat: no select button emitted for non-owner", () => {
			const chat = makeChat({ undecryptable: false, ownerId: 99n })
			const buttons = createMenuButtons({ chat, userId: 42n, origin: "chat", unreadCount: 0 })
			const ids = buttons.map(b => b.id)
			expect(ids).not.toContain("select")
			expect(ids).not.toContain("deselect")
		})

		it("origin=chats: select button is present for owner", () => {
			const chat = makeChat({ undecryptable: false, ownerId: 42n })
			const buttons = createMenuButtons({ chat, userId: 42n, origin: "chats", unreadCount: 0 })
			const ids = buttons.map(b => b.id)
			expect(ids).toContain("select")
		})

		it("unreadCount > 0: markAsRead button is present", () => {
			const chat = makeChat({ undecryptable: false, ownerId: 42n })
			const buttons = createMenuButtons({ chat, userId: 42n, origin: "chats", unreadCount: 5 })
			const ids = buttons.map(b => b.id)
			expect(ids).toContain("markAsRead")
		})

		it("unreadCount === 0: no markAsRead button", () => {
			const chat = makeChat({ undecryptable: false, ownerId: 42n })
			const buttons = createMenuButtons({ chat, userId: 42n, origin: "chats", unreadCount: 0 })
			const ids = buttons.map(b => b.id)
			expect(ids).not.toContain("markAsRead")
		})

		it("muted button checked property is true when chat.muted is true", () => {
			const chat = makeChat({ undecryptable: false, ownerId: 42n, muted: true })
			const buttons = createMenuButtons({ chat, userId: 42n, origin: "chats", unreadCount: 0 })
			const mutedButton = buttons.find(b => b.id === "muted")
			expect(mutedButton).toBeDefined()
			expect(mutedButton!.checked).toBe(true)
		})

		it("muted button checked property is false when chat.muted is false", () => {
			const chat = makeChat({ undecryptable: false, ownerId: 42n, muted: false })
			const buttons = createMenuButtons({ chat, userId: 42n, origin: "chats", unreadCount: 0 })
			const mutedButton = buttons.find(b => b.id === "muted")
			expect(mutedButton).toBeDefined()
			expect(mutedButton!.checked).toBe(false)
		})

		it("all returned button ids are unique for owner with unread messages", () => {
			const chat = makeChat({ undecryptable: false, ownerId: 42n })
			const buttons = createMenuButtons({ chat, userId: 42n, origin: "chats", unreadCount: 3 })
			const ids = buttons.map(b => b.id)
			const uniqueIds = new Set(ids)
			expect(uniqueIds.size).toBe(ids.length)
		})

		it("all returned button ids are unique for non-owner with unread messages", () => {
			const chat = makeChat({ undecryptable: false, ownerId: 99n })
			const buttons = createMenuButtons({ chat, userId: 42n, origin: "chats", unreadCount: 2 })
			const ids = buttons.map(b => b.id)
			const uniqueIds = new Set(ids)
			expect(uniqueIds.size).toBe(ids.length)
		})

		it("isSelected=true produces deselect button instead of select", () => {
			const chat = makeChat({ undecryptable: false, ownerId: 42n })
			const buttons = createMenuButtons({ chat, userId: 42n, origin: "chats", isSelected: true, unreadCount: 0 })
			const ids = buttons.map(b => b.id)
			expect(ids).toContain("deselect")
			expect(ids).not.toContain("select")
		})

		it("participants button is always present for decryptable chats", () => {
			const chat = makeChat({ undecryptable: false, ownerId: 42n })
			const buttons = createMenuButtons({ chat, userId: 42n, origin: "chats", unreadCount: 0 })
			const ids = buttons.map(b => b.id)
			expect(ids).toContain("participants")
		})

		it("non-owner: participants button is present", () => {
			const chat = makeChat({ undecryptable: false, ownerId: 99n })
			const buttons = createMenuButtons({ chat, userId: 42n, origin: "chats", unreadCount: 0 })
			const ids = buttons.map(b => b.id)
			expect(ids).toContain("participants")
		})
	})
})

// ─── M3 — a failing SQLite flush must surface from the send path ─────────────────

// The chat input's send() persists the queued message via this exported helper (T5
// pattern: the test exercises the LIVE component helper, not a re-implementation).
// sync.flushToDisk never throws — it reports persistence failure as `false`; before
// this fix the failure path was unreachable and a failing write left the message
// memory-only with zero signal.
describe("flushInflightMessagesWithAlert", () => {
	beforeEach(() => {
		vi.mocked(sync.flushToDisk).mockReset()
		vi.mocked(alerts.error).mockClear()
	})

	it("alerts when the disk flush reports failure (the message is memory-only)", async () => {
		vi.mocked(sync.flushToDisk).mockResolvedValue(false)

		await flushInflightMessagesWithAlert()

		expect(alerts.error).toHaveBeenCalledWith("chat_message_not_saved_to_device")
	})

	it("stays silent when the flush succeeds", async () => {
		vi.mocked(sync.flushToDisk).mockResolvedValue(true)

		await flushInflightMessagesWithAlert()

		expect(alerts.error).not.toHaveBeenCalled()
	})
})
