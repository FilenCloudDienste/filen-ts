import { describe, expect, it } from "vitest"
import { CUSTOM_EMOJIS, EMOJI_SHORTCODES } from "@/features/chats/lib/emoji"
import {
	EMOJI_PICKER_CATEGORIES,
	MAX_RECENT_EMOJIS,
	emojiForInsertText,
	emojiInsertText,
	emojiPickerCategoryItems,
	insertEmojiAt,
	mergeRecentEmojis,
	moveGridIndex,
	pushRecentEmoji,
	searchEmojiPicker,
	withoutRepeatedGlyphs
} from "@/features/chats/lib/emojiPicker.logic"

const STANDARD = EMOJI_PICKER_CATEGORIES.filter(category => category !== "recent" && category !== "custom")

describe("emoji picker categories", () => {
	it("lists every standard glyph exactly once, by a name the table holds", () => {
		const listed = STANDARD.flatMap(category => emojiPickerCategoryItems(category))
		const chars = listed.map(item => (item.kind === "standard" ? item.char : ""))

		expect(new Set(chars).size).toBe(chars.length)
		expect(new Set(chars)).toEqual(new Set(Object.values(EMOJI_SHORTCODES)))

		for (const item of listed) {
			expect(EMOJI_SHORTCODES[item.name]).toBeDefined()
		}
	})

	it("offers the whole custom pack on the custom tab", () => {
		expect(emojiPickerCategoryItems("custom")).toHaveLength(CUSTOM_EMOJIS.length)
	})

	it("builds a tab once", () => {
		expect(emojiPickerCategoryItems("smileys")).toBe(emojiPickerCategoryItems("smileys"))
	})
})

describe("searchEmojiPicker", () => {
	it("shows a glyph once although two names spell it", () => {
		const thumbsup = { kind: "standard" as const, name: "thumbsup", char: "👍" }
		const plusOne = { kind: "standard" as const, name: "+1", char: "👍" }
		const custom = { kind: "custom" as const, name: "kekw", imageUrl: "https://cdn.filen.io/x.png" }

		expect(withoutRepeatedGlyphs([thumbsup, custom, plusOne])).toEqual([thumbsup, custom])
	})

	it("finds by name", () => {
		expect(searchEmojiPicker("rocket").some(item => item.kind === "standard" && item.char === "🚀")).toBe(true)
	})

	it("returns nothing for a blank query", () => {
		expect(searchEmojiPicker("   ")).toEqual([])
	})
})

describe("insert tokens", () => {
	it("round-trips a standard and a custom emoji", () => {
		const standard = emojiPickerCategoryItems("smileys")[0]
		const custom = emojiPickerCategoryItems("custom")[0]

		expect(standard).toBeDefined()
		expect(custom).toBeDefined()

		if (standard === undefined || custom === undefined) {
			return
		}

		expect(emojiInsertText(custom)).toBe(`:${custom.name}:`)
		expect(emojiForInsertText(emojiInsertText(standard))).toEqual(standard)
		expect(emojiForInsertText(emojiInsertText(custom))).toEqual(custom)
	})

	it("drops a token that names no emoji", () => {
		expect(emojiForInsertText(":not-an-emoji-anywhere:")).toBeUndefined()
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
