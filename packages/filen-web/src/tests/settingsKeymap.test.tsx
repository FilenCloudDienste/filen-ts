// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"

// The registry's only storage calls, stubbed as every keymap test does.
const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	},
	kvDelete: (key: string) => {
		kvStore.delete(key)

		return Promise.resolve()
	}
}))

const { registerAllActions } = await import("@/lib/keymap/actions")
const { comboFor, keymapOverridesLoaded, setUserCombo, clearUserCombo } = await import("@/lib/keymap/registry")
const { useAction } = await import("@/lib/keymap/useAction")
const { SETTINGS_ACTIONS } = await import("@/features/settings/lib/keymap")
const { ignoredOutsideLayer, keyInLayerOf, LAYER_FIELD_TAGS } = await import("@/features/settings/lib/layerKeys")
const { steppedItem } = await import("@/features/settings/lib/stepped.logic")
const { steppedEventEntry } = await import("@/features/settings/components/events/eventsList.logic")

registerAllActions()

afterEach(() => {
	document.body.replaceChildren()
})

function press(init: KeyboardEventInit, target: EventTarget): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })

	target.dispatchEvent(event)

	return event
}

function element(tag: string, parent: Element, role?: string): HTMLElement {
	const node = document.createElement(tag)

	if (role !== undefined) {
		node.setAttribute("role", role)
		node.setAttribute("data-open", "")
	}

	parent.append(node)

	return node
}

describe("settings actions", () => {
	it("resolve to their defaults", () => {
		expect(comboFor("settings.previousSection")).toBe("alt+arrowup")
		expect(comboFor("settings.nextSection")).toBe("alt+arrowdown")
		expect(comboFor("settings.search")).toBe("mod+f")
		expect(comboFor("settings.previousEvent")).toBe("arrowleft")
		expect(comboFor("settings.nextEvent")).toBe("arrowright")
		expect(comboFor("settings.copyEvent")).toBe("mod+c")
		expect(comboFor("settings.showEventInDrive")).toBe("mod+enter")
	})

	it("follow an override", async () => {
		await setUserCombo("settings.nextSection", "alt+pagedown")
		await keymapOverridesLoaded()

		expect(comboFor("settings.nextSection")).toBe("alt+pagedown")

		await clearUserCombo("settings.nextSection")
		await keymapOverridesLoaded()

		expect(comboFor("settings.nextSection")).toBe("alt+arrowdown")
	})

	it("all live in the settings scope", () => {
		for (const def of SETTINGS_ACTIONS) expect(def.scope, def.id).toBe("settings")
	})
})

describe("steppedItem", () => {
	const items = ["a", "b", "c"]

	it("steps from the current item and stops at either end", () => {
		expect(steppedItem(items, "b", 1)).toBe("c")
		expect(steppedItem(items, "b", -1)).toBe("a")
		expect(steppedItem(items, "c", 1)).toBeNull()
		expect(steppedItem(items, "a", -1)).toBeNull()
	})

	it("starts at the first or the last with no current item, or one the list no longer holds", () => {
		expect(steppedItem(items, null, 1)).toBe("a")
		expect(steppedItem(items, null, -1)).toBe("c")
		expect(steppedItem(items, "gone", 1)).toBe("a")
		expect(steppedItem([], null, 1)).toBeNull()
	})
})

describe("steppedEventEntry", () => {
	const entry = (key: string) => ({ type: "unknown", key, timestamp: 0n }) as unknown as Parameters<typeof steppedEventEntry>[1]
	const a = entry("a")
	const b = entry("b")
	const rows = [
		{ type: "day", key: "d1", day: "today", dayStart: 0 },
		{ type: "event", key: "a", entry: a },
		{ type: "day", key: "d2", day: "yesterday", dayStart: 0 },
		{ type: "event", key: "b", entry: b }
	] as unknown as Parameters<typeof steppedEventEntry>[0]

	it("skips the day headers between events", () => {
		expect(steppedEventEntry(rows, a, 1)).toBe(b)
		expect(steppedEventEntry(rows, b, -1)).toBe(a)
	})

	it("has no neighbour past either end, nor for an event the list does not show", () => {
		expect(steppedEventEntry(rows, b, 1)).toBeNull()
		expect(steppedEventEntry(rows, a, -1)).toBeNull()
		expect(steppedEventEntry(rows, entry("other"), 1)).toBeNull()
		expect(steppedEventEntry(rows, null, 1)).toBeNull()
	})
})

describe("keyInLayerOf", () => {
	it("takes a key on the page for a surface on the page, and none with a dialog open", () => {
		const root = element("div", document.body)

		expect(keyInLayerOf(root, document.body)).toBe(true)

		element("div", document.body, "dialog")

		expect(keyInLayerOf(root, document.body)).toBe(false)
	})

	it("takes a key in the dialog holding the surface, never on the page under it", () => {
		const dialog = element("div", document.body, "dialog")
		const root = element("div", dialog)
		const button = element("button", dialog)
		const pageInput = element("input", document.body)

		expect(keyInLayerOf(root, button)).toBe(true)
		expect(keyInLayerOf(root, pageInput)).toBe(false)
	})

	it("stands down under a menu opened over the dialog", () => {
		const dialog = element("div", document.body, "dialog")
		const root = element("div", dialog)

		element("div", document.body, "menu")

		expect(keyInLayerOf(root, root)).toBe(false)
	})
})

describe("ignoredOutsideLayer", () => {
	it("runs the shortcuts list's search from its own search box, in its own dialog only", () => {
		const dialog = element("div", document.body, "dialog")
		const root = element("div", dialog)
		const input = element("input", root)
		const handler = vi.fn((event: KeyboardEvent) => {
			event.preventDefault()
		})

		renderHook(() =>
			useAction("settings.search", handler, {
				ignoreEventWhen: event => ignoredOutsideLayer(event, root),
				enableOnFormTags: LAYER_FIELD_TAGS
			})
		)

		expect(press({ key: "f", code: "KeyF", ctrlKey: true, metaKey: true }, input).defaultPrevented).toBe(true)
		expect(handler).toHaveBeenCalledOnce()
	})

	it("leaves a key pressed on the page under the dialog to the page", () => {
		const dialog = element("div", document.body, "dialog")
		const root = element("div", dialog)
		const handler = vi.fn()

		renderHook(() =>
			useAction("settings.search", handler, {
				ignoreEventWhen: event => ignoredOutsideLayer(event, root),
				enableOnFormTags: LAYER_FIELD_TAGS
			})
		)

		expect(press({ key: "f", code: "KeyF", ctrlKey: true, metaKey: true }, document.body).defaultPrevented).toBe(false)
		expect(handler).not.toHaveBeenCalled()
	})
})
