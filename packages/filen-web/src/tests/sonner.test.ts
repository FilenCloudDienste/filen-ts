// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { createElement } from "react"
import type { ToasterProps } from "sonner"
import "@/lib/i18n"

// Prop-capturing stub for sonner's own Toaster: the assertions are about what this app's wrapper
// hands down (the close affordance, its localized label, the offsets), not about sonner's rendering.
const { capturedProps, clearance, sideClearance, actions, dismiss } = vi.hoisted(() => ({
	capturedProps: [] as ToasterProps[],
	clearance: { value: 0 },
	sideClearance: { value: 0 },
	actions: new Map<string, () => void>(),
	dismiss: vi.fn()
}))

vi.mock("sonner", () => ({
	Toaster: (props: ToasterProps) => {
		capturedProps.push(props)

		return null
	},
	toast: { dismiss }
}))

// The keymap's own guards are useAction's (keymapGuards.test.tsx); here only which handler each action runs.
vi.mock("@/lib/keymap/useAction", () => ({
	useAction: (id: string, handler: () => void) => {
		actions.set(id, handler)
	}
}))

vi.mock("@/providers/themeProvider", () => ({ useTheme: () => ({ theme: "light" }) }))

// The measured clearance is the store's concern (toastClearance.test.ts); here only its mapping onto
// sonner's offsets matters.
vi.mock("@/lib/toastClearance", () => ({ useToastClearance: () => clearance.value, useToastSideClearance: () => sideClearance.value }))

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
	clearance.value = 0
	sideClearance.value = 0
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

	// The global reduced-motion rule freezes every animation except data-slot="spinner";
	// without the slot a long upload's loading toast would sit on a motionless spinner.
	it("marks the loading icon as a spinner so reduced motion cannot freeze it", () => {
		render(createElement(Toaster))

		const { container } = render(createElement("div", null, lastProps().icons?.loading))

		expect(container.querySelector('[data-slot="spinner"]')).not.toBeNull()
	})

	it("sits flush with the bottom edge when nothing occupies the toast corner", () => {
		render(createElement(Toaster))

		const { offset, mobileOffset } = lastProps()

		expect(offset).toEqual({
			right: 24,
			bottom: "calc(24px + env(safe-area-inset-bottom, 0px))"
		})
		expect(mobileOffset).toEqual({ bottom: "calc(16px + env(safe-area-inset-bottom, 0px))" })
	})

	it("lifts by the measured clearance, on both the desktop and the mobile offsets", () => {
		clearance.value = 70

		render(createElement(Toaster))

		const { offset, mobileOffset } = lastProps()

		expect(offset).toEqual({
			right: 24,
			bottom: "max(94px, calc(24px + env(safe-area-inset-bottom, 0px)))"
		})
		expect(mobileOffset).toEqual({ bottom: "max(86px, calc(16px + env(safe-area-inset-bottom, 0px)))" })
	})

	it("moves the column left by a right-docked panel's clearance, keeping the usual edge gap", () => {
		sideClearance.value = 368

		render(createElement(Toaster))

		const { offset, mobileOffset } = lastProps()

		expect(offset).toEqual({
			right: 392,
			bottom: "calc(24px + env(safe-area-inset-bottom, 0px))"
		})
		expect(mobileOffset).toEqual({ bottom: "calc(16px + env(safe-area-inset-bottom, 0px))" })
	})

	it("opens the notifications on app.focusNotifications, not on a key of its own", () => {
		render(createElement(Toaster))

		const { hotkey, customAriaLabel } = lastProps()
		const seen: KeyboardEvent[] = []
		const listener = (event: KeyboardEvent) => {
			seen.push(event)
		}

		document.addEventListener("keydown", listener)
		actions.get("app.focusNotifications")?.()
		document.removeEventListener("keydown", listener)

		// Sonner opens its list on a keydown whose code is every hotkey entry: the one the action sends, and no key's.
		expect(hotkey?.length).toBe(1)
		expect(hotkey?.[0]).not.toMatch(/^(Key|Digit|Alt|Control|Shift|Meta)/)
		expect(seen.map(event => event.code)).toEqual(hotkey)
		expect(customAriaLabel).toBe("Notifications")
	})

	it("dismisses every notification on app.dismissNotifications", () => {
		render(createElement(Toaster))
		actions.get("app.dismissNotifications")?.()

		expect(dismiss).toHaveBeenCalledWith()
	})
})
