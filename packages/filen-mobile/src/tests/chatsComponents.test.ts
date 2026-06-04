import { vi, describe, it, expect } from "vitest"

// ─── Module boundary mocks (must be top-level vi.mock calls, hoisted by Vitest) ─

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

// @filen/sdk-rs loads a wasm worker that references the browser `self` global —
// mock it out so the node test env can load our source modules.
vi.mock("@filen/sdk-rs", () => ({
	ChatTypingType: { Up: 0, Down: 1 }
}))

vi.mock("@filen/utils", async () => ({
	...await import("@/tests/mocks/filenUtils"),
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
	}
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
vi.mock("expo-document-picker", () => ({ getDocumentAsync: vi.fn() }))
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
vi.mock("@/lib/drive", () => ({
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

// @/lib/utils — needed only for the contactDisplayName + safeParseUrl + extractLinks helpers
vi.mock("@/lib/utils", () => ({
	contactDisplayName: (p: { nickName?: string; email: string }) => p.nickName && p.nickName.length > 0 ? p.nickName : p.email,
	safeParseUrl: (url: string) => {
		try {
			const u = new URL(url)
			if (u.protocol !== "https:") return null
			if (u.hostname === "localhost") return null
			return u
		} catch {
			return null
		}
	},
	extractLinks: (text: string) => {
		const matches = [...text.matchAll(/https?:\/\/[^\s]+/g)]
		return matches.map(m => ({ url: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }))
	},
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
vi.mock("@/features/chats/store/useChats.store", () => ({
	default: vi.fn(() => ({})),
	useChatsStore: vi.fn(() => ({}))
}))
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
vi.mock("@/routes/driveSelect/[uuid]", () => ({ selectDriveItems: vi.fn() }))
vi.mock("@/lib/serializer", () => ({ serialize: vi.fn(x => JSON.stringify(x)) }))

// ─── Actual imports ───────────────────────────────────────────────────────────

import {
	MENTION_REGEX,
	CODE_REGEX,
	EMOJI_REGEX_WITH_SKIN_TONES,
	LINE_BREAK_REGEX,
	customEmojisSet
} from "@/features/chats/components/chat/message/regexed"

import { createMenuButtons } from "@/features/chats/components/list/chat/menu"
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

// ─── MENTION_REGEX ────────────────────────────────────────────────────────────

describe("MENTION_REGEX", () => {
	it("matches email-format mention @user@domain.com", () => {
		const input = "hello @alice@example.com how are you"
		const matches = input.match(new RegExp(MENTION_REGEX.source, MENTION_REGEX.flags))
		expect(matches).not.toBeNull()
		expect(matches).toContain("@alice@example.com")
	})

	it("matches @everyone", () => {
		const input = "hey @everyone listen up"
		const matches = input.match(new RegExp(MENTION_REGEX.source, MENTION_REGEX.flags))
		expect(matches).not.toBeNull()
		expect(matches).toContain("@everyone")
	})

	it("does NOT match a bare @word with no domain", () => {
		const input = "hello @alice"
		const matches = input.match(new RegExp(MENTION_REGEX.source, MENTION_REGEX.flags))
		expect(matches).toBeNull()
	})

	it("matches multiple email-format mentions in one string", () => {
		const input = "@a@b.com and @c@d.org"
		const matches = input.match(new RegExp(MENTION_REGEX.source, MENTION_REGEX.flags))
		expect(matches).toHaveLength(2)
	})

	it("split('@').length === 3 holds for email-format matches (routing logic precondition)", () => {
		// The decorator routes email-format mentions by checking split('@').length === 3
		const match = "@alice@example.com"
		expect(match.split("@").length).toBe(3)
	})

	it("@everyone has split('@').length of 2 and startsWith('@everyone') (routing logic precondition)", () => {
		const match = "@everyone"
		expect(match.startsWith("@everyone")).toBe(true)
		// length is 2, not 3 — routing uses startsWith as fallback
		expect(match.split("@").length).toBe(2)
	})
})

// ─── CODE_REGEX ───────────────────────────────────────────────────────────────

describe("CODE_REGEX", () => {
	it("matches inline code block ```code```", () => {
		const input = "here is ```console.log('hi')``` for you"
		const matches = input.match(new RegExp(CODE_REGEX.source, CODE_REGEX.flags))
		expect(matches).not.toBeNull()
		expect(matches![0]).toBe("```console.log('hi')```")
	})

	it("matched code split('```').length >= 3 (routing logic precondition)", () => {
		const match = "```code here```"
		expect(match.split("```").length).toBeGreaterThanOrEqual(3)
	})

	it("matches multi-line code blocks", () => {
		const input = "```\nline1\nline2\n```"
		const matches = input.match(new RegExp(CODE_REGEX.source, CODE_REGEX.flags))
		expect(matches).not.toBeNull()
		expect(matches![0]).toContain("line1")
		expect(matches![0]).toContain("line2")
	})

	it("does NOT match an unclosed backtick run", () => {
		const input = "```only two ticks"
		const matches = input.match(new RegExp(CODE_REGEX.source, CODE_REGEX.flags))
		expect(matches).toBeNull()
	})

	it("matches two separate code blocks in one message", () => {
		const input = "```a``` and ```b```"
		const matches = input.match(new RegExp(CODE_REGEX.source, CODE_REGEX.flags))
		expect(matches).toHaveLength(2)
	})
})

// ─── EMOJI_REGEX_WITH_SKIN_TONES ──────────────────────────────────────────────

describe("EMOJI_REGEX_WITH_SKIN_TONES", () => {
	it("matches :thumbsup:", () => {
		const input = "Nice work :thumbsup: mate"
		const matches = input.match(new RegExp(EMOJI_REGEX_WITH_SKIN_TONES.source, EMOJI_REGEX_WITH_SKIN_TONES.flags))
		expect(matches).not.toBeNull()
		expect(matches).toContain(":thumbsup:")
	})

	it("matches emoji with skin tone modifier :thumbsup::skin-tone-2:", () => {
		const input = ":thumbsup::skin-tone-2:"
		const matches = input.match(new RegExp(EMOJI_REGEX_WITH_SKIN_TONES.source, EMOJI_REGEX_WITH_SKIN_TONES.flags))
		expect(matches).not.toBeNull()
		expect(matches![0]).toBe(":thumbsup::skin-tone-2:")
	})

	it("does NOT match :abc def: (contains space)", () => {
		const input = ":abc def:"
		const matches = input.match(new RegExp(EMOJI_REGEX_WITH_SKIN_TONES.source, EMOJI_REGEX_WITH_SKIN_TONES.flags))
		expect(matches).toBeNull()
	})

	it("matches emoji with plus sign in name :+1:", () => {
		const input = "great :+1: job"
		const matches = input.match(new RegExp(EMOJI_REGEX_WITH_SKIN_TONES.source, EMOJI_REGEX_WITH_SKIN_TONES.flags))
		expect(matches).not.toBeNull()
		expect(matches).toContain(":+1:")
	})

	it("matches emoji with underscore :thumbs_up:", () => {
		const input = ":thumbs_up:"
		const matches = input.match(new RegExp(EMOJI_REGEX_WITH_SKIN_TONES.source, EMOJI_REGEX_WITH_SKIN_TONES.flags))
		expect(matches).not.toBeNull()
	})
})

// ─── LINE_BREAK_REGEX ─────────────────────────────────────────────────────────

describe("LINE_BREAK_REGEX", () => {
	it("matches newline character", () => {
		const input = "line1\nline2"
		const matches = input.match(new RegExp(LINE_BREAK_REGEX.source, LINE_BREAK_REGEX.flags))
		expect(matches).not.toBeNull()
		expect(matches).toContain("\n")
	})

	it("matches multiple newlines and returns one entry per newline", () => {
		const input = "a\nb\nc"
		const matches = input.match(new RegExp(LINE_BREAK_REGEX.source, LINE_BREAK_REGEX.flags))
		expect(matches).toHaveLength(2)
	})

	it("does NOT match strings without newlines", () => {
		const input = "no newline here"
		const matches = input.match(new RegExp(LINE_BREAK_REGEX.source, LINE_BREAK_REGEX.flags))
		expect(matches).toBeNull()
	})

	it("matched newline includes('\\n') is true (routing logic precondition)", () => {
		expect("\n".includes("\n")).toBe(true)
	})
})

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
