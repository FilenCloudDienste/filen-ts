// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { CHATS_ACTIONS } from "@/features/chats/lib/keymap"
import {
	adjacentChatUuid,
	adjacentMessageIndex,
	adjacentUnreadChatUuid,
	chatCommandTargets,
	edgeMessageIndex,
	insertLineBreak,
	wrapInlineCode
} from "@/features/chats/lib/keyboard.logic"
import { composerKeyIntent, isNativeLineBreak, type ComposerKeys } from "@/features/chats/lib/composer.logic"
import { ignoredUnderOverlays } from "@/lib/keymap/useAction"

const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	}
}))

async function freshRegistry() {
	vi.resetModules()

	return import("@/lib/keymap/registry")
}

beforeEach(() => {
	kvStore.clear()
	document.body.replaceChildren()
})

function defaultOf(id: string): string | undefined {
	return CHATS_ACTIONS.find(def => def.id === id)?.defaultCombo
}

function key(code: string, modifiers: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) {
	return {
		code,
		key: code,
		ctrlKey: modifiers.ctrlKey ?? false,
		metaKey: modifiers.metaKey ?? false,
		shiftKey: modifiers.shiftKey ?? false,
		altKey: modifiers.altKey ?? false
	}
}

const DEFAULT_KEYS: ComposerKeys = {
	send: "enter",
	newline: "shift+enter",
	editLast: "arrowup",
	cancel: "escape",
	inlineCode: "mod+e",
	attach: "mod+shift+u",
	attachFromDrive: ""
}

describe("CHATS_ACTIONS", () => {
	it("ships the batch's defaults", () => {
		expect(defaultOf("chats.newChat")).toBe("n")
		expect(defaultOf("chats.search")).toBe("mod+f")
		expect(defaultOf("chats.nextChat")).toBe("alt+arrowdown")
		expect(defaultOf("chats.previousChat")).toBe("alt+arrowup")
		expect(defaultOf("chats.nextUnread")).toBe("alt+shift+arrowdown")
		expect(defaultOf("chats.previousUnread")).toBe("alt+shift+arrowup")
		expect(defaultOf("chats.rename")).toBe("f2")
		expect(defaultOf("chats.deleteSelected")).toBe("delete,backspace")
		expect(defaultOf("chats.jumpToLatest")).toBe("end")
		expect(defaultOf("chats.composer.send")).toBe("enter")
		expect(defaultOf("chats.composer.attach")).toBe("mod+shift+u")
		expect(defaultOf("chats.message.reply")).toBe("r")
		expect(defaultOf("chats.message.menu")).toBe("shift+f10")
	})

	it("leaves mark read, mute, participants, attach from Cloud Drive, retry and remove unassigned", () => {
		for (const id of [
			"chats.markRead",
			"chats.mute",
			"chats.participants",
			"chats.composer.attachFromDrive",
			"chats.message.retry",
			"chats.message.remove"
		]) {
			expect(defaultOf(id), id).toBe("")
		}
	})

	it("resolves the defaults and a user override through the registry", async () => {
		const { registerAction, comboFor, setUserCombo } = await freshRegistry()

		for (const def of CHATS_ACTIONS) {
			registerAction(def)
		}

		expect(comboFor("chats.composer.send")).toBe("enter")

		await setUserCombo("chats.composer.send", "mod+enter")

		expect(comboFor("chats.composer.send")).toBe("mod+enter")
	})
})

describe("composerKeyIntent", () => {
	it("maps the default keys", () => {
		expect(composerKeyIntent(key("Enter"), DEFAULT_KEYS, false)).toBe("send")
		expect(composerKeyIntent(key("Enter", { shiftKey: true }), DEFAULT_KEYS, false)).toBe("newline")
		expect(composerKeyIntent(key("ArrowUp"), DEFAULT_KEYS, false)).toBe("editLast")
		expect(composerKeyIntent(key("Escape"), DEFAULT_KEYS, false)).toBe("cancel")
		expect(composerKeyIntent(key("KeyE", { ctrlKey: true }), DEFAULT_KEYS, false)).toBe("inlineCode")
		expect(composerKeyIntent(key("KeyE", { metaKey: true }), DEFAULT_KEYS, true)).toBe("inlineCode")
		expect(composerKeyIntent(key("KeyU", { ctrlKey: true, shiftKey: true }), DEFAULT_KEYS, false)).toBe("attach")
	})

	it("matches modifiers exactly: Ctrl, Cmd or Alt with Enter never sends", () => {
		expect(composerKeyIntent(key("Enter", { ctrlKey: true }), DEFAULT_KEYS, false)).toBeNull()
		expect(composerKeyIntent(key("Enter", { metaKey: true }), DEFAULT_KEYS, true)).toBeNull()
		expect(composerKeyIntent(key("Enter", { altKey: true }), DEFAULT_KEYS, false)).toBeNull()
		expect(composerKeyIntent(key("ArrowUp", { altKey: true }), DEFAULT_KEYS, false)).toBeNull()
	})

	it("follows a rebound send: Enter is left to the field, Mod+Enter sends", () => {
		const keys = { ...DEFAULT_KEYS, send: "mod+enter", newline: "shift+enter,enter" }

		expect(composerKeyIntent(key("Enter"), keys, false)).toBe("newline")
		expect(composerKeyIntent(key("Enter", { ctrlKey: true }), keys, false)).toBe("send")
	})

	it("matches nothing for an unbound command", () => {
		expect(composerKeyIntent(key("Enter"), { ...DEFAULT_KEYS, send: "" }, false)).toBeNull()
	})

	it("leaves only a bare Shift+Enter to the field's own line break", () => {
		expect(isNativeLineBreak({ key: "Enter", shiftKey: true, ctrlKey: false, metaKey: false, altKey: false })).toBe(true)
		expect(isNativeLineBreak({ key: "Enter", shiftKey: false, ctrlKey: true, metaKey: false, altKey: false })).toBe(false)
	})
})

describe("conversation targeting", () => {
	const rows = [{ uuid: "a" }, { uuid: "b" }, { uuid: "c" }, { uuid: "d" }]

	it("steps from the open conversation and stops at either end", () => {
		expect(adjacentChatUuid(rows, "b", 1)).toBe("c")
		expect(adjacentChatUuid(rows, "b", -1)).toBe("a")
		expect(adjacentChatUuid(rows, "d", 1)).toBeNull()
		expect(adjacentChatUuid(rows, "a", -1)).toBeNull()
	})

	it("starts at the matching end with no conversation open", () => {
		expect(adjacentChatUuid(rows, "", 1)).toBe("a")
		expect(adjacentChatUuid(rows, "", -1)).toBe("d")
		expect(adjacentChatUuid([], "", 1)).toBeNull()
	})

	it("finds the nearest unread one in either direction, never the open one", () => {
		const unread = new Set(["a", "b", "d"])
		const hasUnread = (row: { uuid: string }) => unread.has(row.uuid)

		expect(adjacentUnreadChatUuid(rows, "b", 1, hasUnread)).toBe("d")
		expect(adjacentUnreadChatUuid(rows, "b", -1, hasUnread)).toBe("a")
		expect(adjacentUnreadChatUuid(rows, "d", 1, hasUnread)).toBeNull()
		expect(adjacentUnreadChatUuid(rows, "", 1, hasUnread)).toBe("a")
		expect(adjacentUnreadChatUuid(rows, "", -1, hasUnread)).toBe("d")
	})

	it("acts on the selection, else the open conversation", () => {
		expect(chatCommandTargets(["x", "y"], "open")).toEqual(["x", "y"])
		expect(chatCommandTargets([], "open")).toEqual(["open"])
		expect(chatCommandTargets([], undefined)).toEqual([])
	})
})

describe("message focus", () => {
	// Bottom-up: index 0 is the newest.
	const rows = [{ kind: "message" }, { kind: "time" }, { kind: "message" }, { kind: "unread" }, { kind: "message" }, { kind: "time" }]

	it("moves between message rows, skipping headers and the divider", () => {
		expect(adjacentMessageIndex(rows, 0, 1)).toBe(2)
		expect(adjacentMessageIndex(rows, 2, 1)).toBe(4)
		expect(adjacentMessageIndex(rows, 4, 1)).toBe(-1)
		expect(adjacentMessageIndex(rows, 4, -1)).toBe(2)
		expect(adjacentMessageIndex(rows, 0, -1)).toBe(-1)
	})

	it("finds the newest and the oldest loaded message", () => {
		expect(edgeMessageIndex(rows, true)).toBe(0)
		expect(edgeMessageIndex(rows, false)).toBe(4)
		expect(edgeMessageIndex([{ kind: "time" }], true)).toBe(-1)
	})

	it("stands down while a dialog or menu is open over the thread", () => {
		const event = { repeat: false, key: "r", isComposing: false, keyCode: 82, getModifierState: () => false }

		expect(ignoredUnderOverlays(event)).toBe(false)

		const menu = document.createElement("div")

		menu.setAttribute("role", "menu")
		menu.setAttribute("data-open", "")
		document.body.append(menu)

		expect(ignoredUnderOverlays(event)).toBe(true)
	})
})

describe("composer edits", () => {
	it("wraps the selection in backticks, keeping it selected", () => {
		expect(wrapInlineCode("say hello now", 4, 9)).toEqual({ value: "say `hello` now", selectionStart: 5, selectionEnd: 10 })
	})

	it("inserts an empty pair with the caret between when nothing is selected", () => {
		expect(wrapInlineCode("ab", 1, 1)).toEqual({ value: "a``b", selectionStart: 2, selectionEnd: 2 })
	})

	it("inserts a line break over the selection", () => {
		expect(insertLineBreak("one two", 3, 4)).toEqual({ value: "one\ntwo", caret: 4 })
	})
})
