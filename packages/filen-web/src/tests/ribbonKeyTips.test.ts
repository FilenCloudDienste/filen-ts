import { describe, expect, it } from "vitest"
import {
	controlKeyTips,
	createKeyTipTrigger,
	keyTipCharacters,
	matchKeyTip,
	tabKeyTips,
	type KeyTipTriggerEvent
} from "@/features/office/components/ribbon/ribbonKeyTips"

// KeyTips' letters and the keys that show them: Office's default tab letters, prefix-free generated tips, and Alt+Windows
// in the browser (a bare Alt and F10 only in the desktop shell).

function key(key: string, modifiers: Partial<KeyTipTriggerEvent> = {}): KeyTipTriggerEvent {
	return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, ...modifiers }
}

function prefixFree(tips: readonly string[]): boolean {
	return tips.every((tip, index) => tips.every((other, at) => at === index || !other.startsWith(tip)))
}

describe("tabKeyTips", () => {
	it("gives Word's, Excel's and PowerPoint's default tab letters", () => {
		expect(
			tabKeyTips([
				{ id: "home", label: "Home" },
				{ id: "insert", label: "Insert" },
				{ id: "layout", label: "Layout" },
				{ id: "references", label: "References" },
				{ id: "review", label: "Review" },
				{ id: "view", label: "View" }
			])
		).toEqual(["H", "N", "P", "S", "R", "W"])
		expect(
			tabKeyTips([
				{ id: "home", label: "Home" },
				{ id: "data", label: "Data" },
				{ id: "view", label: "View" }
			])
		).toEqual(["H", "A", "W"])
		expect(
			tabKeyTips([
				{ id: "design", label: "Design" },
				{ id: "transitions", label: "Transitions" },
				{ id: "animations", label: "Animations" },
				{ id: "slideShow", label: "Slide Show" }
			])
		).toEqual(["G", "K", "A", "S"])
	})

	it("puts contextual tabs under J and others on a free letter, never File's F", () => {
		const tips = tabKeyTips([
			{ id: "home", label: "Home" },
			{ id: "arrange", label: "Arrange" },
			{ id: "fancy", label: "Format" },
			{ id: "table", label: "Table", contextual: true },
			{ id: "picture", label: "Picture", contextual: true }
		])

		expect(tips).toEqual(["H", "A", "O", "JT", "JP"])
		expect(prefixFree(["F", ...tips])).toBe(true)
	})
})

describe("controlKeyTips", () => {
	it("gives a unique first letter alone and shared ones two letters, prefix-free", () => {
		const tips = controlKeyTips(["Undo", "Paste", "Bold", "Borders", "Bullets", "Italic", "B"])

		expect(tips).toEqual(["U", "P", "BO", "BR", "BU", "I", "B1"])
		expect(prefixFree(tips)).toBe(true)
	})
})

describe("matchKeyTip", () => {
	it("picks an exact tip, waits on a prefix, and rejects the rest", () => {
		const tips = ["H", "JT", "JP"]

		expect(matchKeyTip(tips, "H")).toBe(0)
		expect(matchKeyTip(tips, "J")).toBe("prefix")
		expect(matchKeyTip(tips, "JP")).toBe(2)
		expect(matchKeyTip(tips, "Q")).toBeNull()
	})
})

describe("keyTipCharacters", () => {
	it("reads the printed letter, then the key's for another layout", () => {
		expect(keyTipCharacters({ key: "h", code: "KeyH" })).toEqual(["H"])
		expect(keyTipCharacters({ key: "р", code: "KeyH" })).toEqual(["Р", "H"])
		expect(keyTipCharacters({ key: "ArrowDown", code: "ArrowDown" })).toEqual([])
	})
})

describe("createKeyTipTrigger", () => {
	it("fires on Alt+Windows released alone in the browser, never on a bare Alt or F10", () => {
		const trigger = createKeyTipTrigger("chord")

		expect(trigger.keydown(key("Alt", { altKey: true }))).toBe(false)
		expect(trigger.keyup(key("Alt"))).toBe(false)
		expect(trigger.keydown(key("F10"))).toBe(false)

		trigger.keydown(key("Alt", { altKey: true }))
		trigger.keydown(key("Meta", { altKey: true, metaKey: true }))
		expect(trigger.keyup(key("Meta", { altKey: true }))).toBe(true)
		// The other modifier's release does not fire again.
		expect(trigger.keyup(key("Alt"))).toBe(false)
	})

	it("leaves a shortcut held with the chord (Alt+Command+I) alone", () => {
		const trigger = createKeyTipTrigger("chord")

		trigger.keydown(key("Meta", { metaKey: true }))
		trigger.keydown(key("Alt", { altKey: true, metaKey: true }))
		trigger.keydown(key("i", { altKey: true, metaKey: true }))
		expect(trigger.keyup(key("Alt", { metaKey: true }))).toBe(false)
	})

	it("fires on a bare Alt and on F10 in the desktop shell, not on Alt with a letter or a click", () => {
		const trigger = createKeyTipTrigger("alt")

		trigger.keydown(key("Alt", { altKey: true }))
		expect(trigger.keyup(key("Alt"))).toBe(true)
		expect(trigger.keydown(key("F10"))).toBe(true)
		expect(trigger.keydown(key("F10", { shiftKey: true }))).toBe(false)

		trigger.keydown(key("Alt", { altKey: true }))
		trigger.keydown(key("h", { altKey: true }))
		expect(trigger.keyup(key("Alt"))).toBe(false)

		trigger.keydown(key("Alt", { altKey: true }))
		trigger.reset()
		expect(trigger.keyup(key("Alt"))).toBe(false)

		// AltGr is a character key's modifier, not Alt.
		trigger.keydown(key("AltGraph", { altKey: true, ctrlKey: true }))
		expect(trigger.keyup(key("AltGraph"))).toBe(false)
	})
})
