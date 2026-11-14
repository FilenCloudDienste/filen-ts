// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"

vi.mock("@/lib/storage/preference", () => ({
	kvPreference: () => ({ get: () => new Promise(() => undefined), set: () => Promise.resolve() })
}))

const { useSmoothTransitionsStore } = await import("@/features/audio/store/useSmoothTransitionsStore")
const { DEFAULT_SMOOTH_TRANSITIONS_PREFS } = await import("@/features/audio/lib/smoothTransitions.types")
const { SmoothTransitionsRows } = await import("@/features/settings/components/audio/smoothTransitionsRows")

type Unavailable = ReturnType<typeof useSmoothTransitionsStore.getState>["unavailable"]

function setSmooth(enabled: boolean, unavailable: Unavailable, fadeSeconds = DEFAULT_SMOOTH_TRANSITIONS_PREFS.fadeSeconds): void {
	useSmoothTransitionsStore.setState({ prefs: { ...DEFAULT_SMOOTH_TRANSITIONS_PREFS, enabled, fadeSeconds }, unavailable })
}

function masterSwitch(): HTMLElement {
	return screen.getByRole("switch", { name: "Smooth transitions" })
}

afterEach(() => {
	cleanup()
	setSmooth(DEFAULT_SMOOTH_TRANSITIONS_PREFS.enabled, null)
})

describe("Settings › Audio smooth transitions", () => {
	it("checks the switch only while tracks blend, and says why only while it is locked", () => {
		setSmooth(true, "degraded")
		render(createElement(SmoothTransitionsRows))

		expect(masterSwitch().getAttribute("aria-checked")).toBe("false")
		expect(masterSwitch().hasAttribute("title")).toBe(false)
		expect(screen.getByText("Off until you reload: this device stopped the audio mixer.")).toBeTruthy()

		fireEvent.click(masterSwitch())

		expect(useSmoothTransitionsStore.getState().prefs.enabled).toBe(false)
		expect(masterSwitch().getAttribute("title")).toBe("Off until you reload: this device stopped the audio mixer.")

		act(() => {
			setSmooth(true, null)
		})

		expect(masterSwitch().getAttribute("aria-checked")).toBe("true")
		expect(masterSwitch().hasAttribute("title")).toBe(false)
	})

	it("offers the preset lengths as one radio group named by the row's label", () => {
		setSmooth(true, null, 9)
		render(createElement(SmoothTransitionsRows))

		const group = screen.getByRole("radiogroup", { name: "Crossfade length" })
		const radios = within(group).getAllByRole("radio")

		expect(radios.map(radio => [radio.getAttribute("aria-label"), radio.getAttribute("aria-checked")])).toEqual([
			["3 seconds", "false"],
			["6 seconds", "false"],
			["9 seconds", "true"],
			["12 seconds", "false"]
		])
		const sliderLabel = document.querySelector("input[type=range]")?.getAttribute("aria-labelledby")

		expect(sliderLabel).toBe(group.getAttribute("aria-labelledby"))
		expect(document.getElementById(sliderLabel ?? "")?.textContent).toBe("Crossfade length")
		// The row's own label names both controls; no hidden duplicate of it.
		expect(screen.getAllByText("Crossfade length")).toHaveLength(1)

		fireEvent.click(within(group).getByRole("radio", { name: "3 seconds" }))

		expect(useSmoothTransitionsStore.getState().prefs.fadeSeconds).toBe(3)
	})

	it("names Custom with the length while it is not a preset, never as pressed", () => {
		setSmooth(true, null, 6)
		render(createElement(SmoothTransitionsRows))

		const custom = screen.getByRole("button", { name: "Custom" })

		expect(custom.hasAttribute("aria-pressed")).toBe(false)

		act(() => {
			setSmooth(true, null, 7)
		})

		expect(screen.getByRole("button", { name: "Custom, 7 seconds" }).hasAttribute("aria-pressed")).toBe(false)
		expect(screen.getAllByRole("radio").every(radio => radio.getAttribute("aria-checked") === "false")).toBe(true)
	})
})
