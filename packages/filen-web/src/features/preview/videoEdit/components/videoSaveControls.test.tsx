// @vitest-environment happy-dom

import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { ExportBar, type ExportState } from "@/features/preview/videoEdit/components/videoSaveControls"
import "@/lib/i18n"

// When an export stops, focus lands on Retry only when Retry can take it; offline Retry is disabled, so Dismiss
// takes focus instead of focus dropping to the page.

const noop = () => undefined
const FAILED: ExportState = { status: "failed", code: "unknown" }

function renderBar(online: boolean) {
	render(
		<ExportBar
			state={FAILED}
			online={online}
			onBackground={noop}
			onCancel={noop}
			onRetry={noop}
			onDismiss={noop}
		/>
	)

	const buttons = screen.getAllByRole("button")

	return { dismiss: buttons[0], retry: buttons[1] }
}

describe("ExportBar focus", () => {
	it("focuses Dismiss when the export failed offline", () => {
		const { dismiss, retry } = renderBar(false)

		expect(retry).toHaveProperty("disabled", true)
		expect(document.activeElement).toBe(dismiss)
	})

	it("focuses Retry when the export failed online", () => {
		const { retry } = renderBar(true)

		expect(document.activeElement).toBe(retry)
	})
})
