// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { createElement } from "react"
import type { ToasterProps } from "sonner"
import "@/lib/i18n"

// Prop-capturing stub for sonner's own Toaster: the assertions are about what this app's wrapper
// hands down (the close affordance and its localized label), not about sonner's rendering.
const { capturedProps } = vi.hoisted(() => ({ capturedProps: [] as ToasterProps[] }))

vi.mock("sonner", () => ({
	Toaster: (props: ToasterProps) => {
		capturedProps.push(props)

		return null
	}
}))

vi.mock("@/providers/themeProvider", () => ({ useTheme: () => ({ theme: "light" }) }))

import { Toaster } from "@/components/ui/sonner"

function lastProps(): ToasterProps {
	const props = capturedProps.at(-1)

	if (props === undefined) {
		throw new Error("sonner's Toaster was never rendered")
	}

	return props
}

afterEach(() => {
	capturedProps.length = 0
	cleanup()
})

describe("ui/sonner Toaster", () => {
	it("turns sonner's close button on so every toast has a tabbable dismiss", () => {
		render(createElement(Toaster))

		expect(lastProps().closeButton).toBe(true)
	})

	it("labels that close button from the catalog without dropping the class the toast styles hang off", () => {
		render(createElement(Toaster))

		const { toastOptions } = lastProps()

		expect(toastOptions?.closeButtonAriaLabel).toBe("Dismiss notification")
		expect(toastOptions?.classNames?.toast).toBe("cn-toast")
	})

	it("lets a call site turn the close button back off — the default is a default, not a lock", () => {
		render(createElement(Toaster, { closeButton: false }))

		expect(lastProps().closeButton).toBe(false)
	})
})
