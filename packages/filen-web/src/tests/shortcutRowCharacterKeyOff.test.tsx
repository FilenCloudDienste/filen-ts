// @vitest-environment jsdom

import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import "@/lib/i18n"
import { ShortcutRow } from "@/lib/keymap/shortcutRow"
import type { ResolvedAction } from "@/lib/keymap/registry"

// A chip dimmed because single-key shortcuts are off says so to a keyboard or screen reader user too, not only
// through a hover title.

const ACTION: ResolvedAction = {
	id: "test.singleKey",
	defaultCombo: "j",
	scope: "global",
	descriptionKey: "settings:keyboardAdd",
	combo: "j",
	platformDefault: "j",
	overridden: false
}

const OFF_TEXT = "Off while single-key shortcuts are off"

function renderRow(characterKeys: boolean) {
	return render(
		<ShortcutRow
			action={ACTION}
			recordingSlot={undefined}
			armed={false}
			problem={null}
			conflicts={undefined}
			characterKeys={characterKeys}
			layout={null}
			compact={false}
			nameOf={id => id}
			onRecord={() => undefined}
			onCancel={() => undefined}
			onSpecial={() => undefined}
		/>
	)
}

// The text aria-describedby points the change button at.
function changeDescription(): string {
	const ids = screen.getByRole("button", { name: /^Change/ }).getAttribute("aria-describedby") ?? ""

	return ids
		.split(" ")
		.map(id => document.getElementById(id)?.textContent ?? "")
		.join(" ")
}

describe("ShortcutRow single-key chip", () => {
	it("describes the change button with the off text while single-key shortcuts are off", () => {
		renderRow(false)

		expect(changeDescription()).toContain(OFF_TEXT)
	})

	it("leaves the off text out while single-key shortcuts are on", () => {
		renderRow(true)

		expect(changeDescription()).not.toContain(OFF_TEXT)
		expect(screen.queryByText(OFF_TEXT)).toBeNull()
	})
})
