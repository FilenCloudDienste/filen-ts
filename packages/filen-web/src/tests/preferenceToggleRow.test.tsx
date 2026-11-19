// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import { PreferenceToggleRow } from "@/features/settings/components/settingRows"

afterEach(() => {
	cleanup()
})

function renderRow(disabled: boolean, disabledReason: string | undefined): HTMLElement {
	render(
		<PreferenceToggleRow
			title="Login alerts"
			description="Mail me on every login"
			checked={false}
			disabled={disabled}
			disabledReason={disabledReason}
			onCheckedChange={vi.fn()}
		/>
	)

	return screen.getByRole("switch", { name: "Login alerts" })
}

describe("PreferenceToggleRow", () => {
	it("gives a disabled switch its reason as the accessible description, not a title", () => {
		const toggle = renderRow(true, "Unavailable while offline")

		expect(toggle.getAttribute("title")).toBeNull()
		expect(document.getElementById(toggle.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Unavailable while offline")
	})

	it("describes nothing while enabled or disabled without a reason", () => {
		expect(renderRow(false, "Unavailable while offline").getAttribute("aria-describedby")).toBeNull()
		cleanup()
		expect(renderRow(true, undefined).getAttribute("aria-describedby")).toBeNull()
	})
})
