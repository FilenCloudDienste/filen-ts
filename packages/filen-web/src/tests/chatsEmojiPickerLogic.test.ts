import { describe, expect, it } from "vitest"
import { CUSTOM_EMOJIS, emojiSet } from "@/features/chats/lib/emoji"
import { withSkinTone } from "@/features/chats/lib/emojiData"
import {
	EMOJI_PICKER_CATEGORIES,
	MAX_RECENT_EMOJIS,
	emojiForRecentToken,
	emojiInsertText,
	emojiLabel,
	emojiPickerCategoryItems,
	emojiRecentToken,
	insertEmojiAt,
	mergeRecentEmojis,
	moveGridIndex,
	pushRecentEmoji,
	searchEmojiPicker
} from "@/features/chats/lib/emojiPicker.logic"

const STANDARD = EMOJI_PICKER_CATEGORIES.filter(category => category !== "recent" && category !== "custom")

function standard(char: string) {
	const emoji = emojiSet().byChar.get(char)

	if (emoji === undefined) {
		throw new Error(`${char} is not in the set`)
	}

	return emoji
}

describe("emoji picker categories", () => {
	it("offers Unicode's nine groups, flags included, between recently used and the custom pack", () => {
		expect(EMOJI_PICKER_CATEGORIES).toEqual([
			"recent",
			"smileys",
			"people",
			"nature",
			"food",
			"travel",
			"activities",
			"objects",
			"symbols",
			"flags",
			"custom"
		])
	})

	it("lists the full set, each emoji once, flags and the newest emoji included", () => {
		const listed = STANDARD.flatMap(category => emojiPickerCategoryItems(category))
		const chars = listed.map(item => (item.kind === "standard" ? item.char : ""))

		expect(listed.length).toBeGreaterThan(1900)
		expect(new Set(chars).size).toBe(chars.length)
		expect(emojiPickerCategoryItems("flags").map(item => (item.kind === "standard" ? item.char : ""))).toEqual(
			expect.arrayContaining(["🇩🇪", "🇯🇵", "🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}", "🏁"])
		)
		// Unicode 16 (2024): a platform font may lack it, it is still offered.
		expect(chars).toContain("🫩")
	})

	it("offers the whole custom pack on the custom tab", () => {
		expect(emojiPickerCategoryItems("custom")).toHaveLength(CUSTOM_EMOJIS.length)
	})

	it("builds a tab once", () => {
		expect(emojiPickerCategoryItems("smileys")).toBe(emojiPickerCategoryItems("smileys"))
		expect(emojiPickerCategoryItems("custom")).toBe(emojiPickerCategoryItems("custom"))
	})
})

describe("searchEmojiPicker", () => {
	it("finds by name, by keyword and by shortcode", () => {
		expect(searchEmojiPicker("rocket")[0]).toBe(standard("🚀"))
		expect(searchEmojiPicker("cheerful")).toContain(standard("😀"))
		expect(searchEmojiPicker("flag-de")[0]).toBe(standard("🇩🇪"))
		expect(searchEmojiPicker("Germany")).toContain(standard("🇩🇪"))
		expect(searchEmojiPicker("thumbs up")[0]).toBe(standard("👍"))
	})

	it("returns nothing for a blank query", () => {
		expect(searchEmojiPicker("   ")).toEqual([])
	})
})

describe("skin tones", () => {
	it("applies a tone to an emoji that takes one, on each part that takes it", () => {
		expect(withSkinTone(standard("👋"), 3)).toBe("👋🏽")
		expect(withSkinTone(standard("☝️"), 1)).toBe("☝🏻")
		expect(withSkinTone(standard("🧑‍🤝‍🧑"), 5)).toBe("🧑🏿‍🤝‍🧑🏿")
		expect(withSkinTone(standard("🏌️‍♀️"), 2)).toBe("🏌🏼‍♀️")
	})

	it("leaves an emoji that takes none, and the default tone, as they are", () => {
		expect(withSkinTone(standard("🚀"), 4)).toBe("🚀")
		expect(withSkinTone(standard("👋"), 0)).toBe("👋")
	})
})

describe("insert and recent tokens", () => {
	it("inserts a standard emoji in the chosen tone and a custom one as its shortcode", () => {
		const custom = emojiPickerCategoryItems("custom")[0]

		if (custom === undefined) {
			throw new Error("no custom emoji")
		}

		expect(emojiInsertText(standard("👋"), 4)).toBe("👋🏾")
		expect(emojiInsertText(custom, 4)).toBe(`:${custom.name}:`)
	})

	it("remembers a standard emoji untoned and round-trips both kinds", () => {
		const custom = emojiPickerCategoryItems("custom")[0]

		if (custom === undefined) {
			throw new Error("no custom emoji")
		}

		expect(emojiRecentToken(standard("👋"))).toBe("👋")
		expect(emojiForRecentToken("👋")).toBe(standard("👋"))
		expect(emojiForRecentToken(emojiRecentToken(custom))).toEqual(custom)
	})

	it("reads a token stored without its VS16 (the old curated table's form)", () => {
		expect(emojiForRecentToken("❤")).toBe(standard("❤️"))
	})

	it("drops a token that names no emoji", () => {
		expect(emojiForRecentToken(":not-an-emoji-anywhere:")).toBeUndefined()
		expect(emojiForRecentToken("x")).toBeUndefined()
	})

	it("labels a standard emoji by its CLDR name", () => {
		expect(emojiLabel(standard("🇩🇪"))).toBe("flag: Germany")
	})
})

describe("recent emoji", () => {
	it("moves a use to the front once", () => {
		expect(pushRecentEmoji(["a", "b", "c"], "b")).toEqual(["b", "a", "c"])
	})

	it("caps the list", () => {
		const full = Array.from({ length: MAX_RECENT_EMOJIS }, (_, index) => String(index))

		expect(pushRecentEmoji(full, "new")).toHaveLength(MAX_RECENT_EMOJIS)
		expect(pushRecentEmoji(full, "new")[0]).toBe("new")
	})

	it("keeps this session's uses above the stored list", () => {
		expect(mergeRecentEmojis(["x", "a"], ["a", "b"])).toEqual(["x", "a", "b"])
	})
})

describe("moveGridIndex", () => {
	// 3 columns, 7 items: rows [0 1 2] [3 4 5] [6]
	it("moves by one across and by a row up and down", () => {
		expect(moveGridIndex(4, "ArrowRight", 7, 3)).toBe(5)
		expect(moveGridIndex(4, "ArrowLeft", 7, 3)).toBe(3)
		expect(moveGridIndex(4, "ArrowUp", 7, 3)).toBe(1)
		expect(moveGridIndex(1, "ArrowDown", 7, 3)).toBe(4)
	})

	it("stays inside the grid", () => {
		expect(moveGridIndex(0, "ArrowLeft", 7, 3)).toBe(0)
		expect(moveGridIndex(6, "ArrowRight", 7, 3)).toBe(6)
		expect(moveGridIndex(1, "ArrowUp", 7, 3)).toBe(1)
		expect(moveGridIndex(6, "ArrowDown", 7, 3)).toBe(6)
	})

	it("drops into a shorter last row at its last cell", () => {
		expect(moveGridIndex(5, "ArrowDown", 7, 3)).toBe(6)
	})

	it("goes to the row's ends on Home and End", () => {
		expect(moveGridIndex(4, "Home", 7, 3)).toBe(3)
		expect(moveGridIndex(4, "End", 7, 3)).toBe(5)
		expect(moveGridIndex(6, "End", 7, 3)).toBe(6)
	})

	it("ignores other keys and an empty grid", () => {
		expect(moveGridIndex(0, "a", 7, 3)).toBeNull()
		expect(moveGridIndex(0, "ArrowRight", 0, 3)).toBeNull()
	})
})

describe("insertEmojiAt", () => {
	it("inserts at the caret", () => {
		expect(insertEmojiAt("hello world", 5, 5, "👋")).toEqual({ value: "hello👋 world", caret: 7 })
	})

	it("replaces the selection", () => {
		expect(insertEmojiAt("hello world", 6, 11, "🌍")).toEqual({ value: "hello 🌍", caret: 8 })
	})

	it("spaces a custom shortcode off the character before it", () => {
		expect(insertEmojiAt("at 10:30", 8, 8, ":kekw:")).toEqual({ value: "at 10:30 :kekw:", caret: 15 })
		expect(insertEmojiAt("", 0, 0, ":kekw:")).toEqual({ value: ":kekw:", caret: 6 })
		expect(insertEmojiAt("hi ", 3, 3, ":kekw:")).toEqual({ value: "hi :kekw:", caret: 9 })
	})
})
