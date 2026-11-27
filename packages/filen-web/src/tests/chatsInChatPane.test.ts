// @vitest-environment jsdom

import { describe, expect, it } from "vitest"
import { inChatPane } from "@/features/chats/lib/keyboard.logic"

// Mod+F searches the open conversation with focus in its pane and the conversation list anywhere else.
describe("inChatPane", () => {
	it("is true inside the open conversation's pane only", () => {
		const pane = document.createElement("div")
		const field = document.createElement("textarea")
		const sidebarInput = document.createElement("input")

		pane.setAttribute("data-chat-pane", "")
		pane.append(field)
		document.body.append(pane, sidebarInput)

		expect(inChatPane(pane)).toBe(true)
		expect(inChatPane(field)).toBe(true)
		expect(inChatPane(sidebarInput)).toBe(false)
		expect(inChatPane(document.body)).toBe(false)
		expect(inChatPane(null)).toBe(false)
	})
})
