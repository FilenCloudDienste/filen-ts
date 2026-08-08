// @vitest-environment happy-dom

// Guards the native half of the WebView keyboard fix (#102).
//
// A KeyboardAvoidingView with no `behavior` renders a plain View and avoids nothing at all — its
// animated style is a switch over `behavior` whose default branch returns {}. That is exactly how
// the editors shipped, so the props are asserted rather than assumed.
//
// Shrinking the view is not redundant with the in-page sizing in src/lib/domViewport: it is what
// shrinks the LAYOUT viewport, and without that iOS reveals the caret by panning the visual viewport
// inside the leftover room, dragging the page up and leaving a keyboard-sized band of nothing above
// the keyboard.

import { vi, describe, it, expect, beforeEach } from "vitest"
import { createElement } from "react"
import { render } from "@testing-library/react"

const { keyboardAvoidingViewPropsSpy, insets } = vi.hoisted(() => ({
	keyboardAvoidingViewPropsSpy: vi.fn(),
	insets: { top: 0, bottom: 0, left: 0, right: 0 }
}))

// DomKeyboardHost reads the horizontal safe area to stop the WebView short of the sensor housing.
vi.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => insets
}))

vi.mock("@/components/ui/view", () => ({
	default: ({ children }: { children?: unknown }) => children ?? null,
	KeyboardAvoidingView: (props: Record<string, unknown>) => {
		keyboardAvoidingViewPropsSpy(props)

		return (props["children"] as React.ReactNode) ?? null
	}
}))

import DomKeyboardHost from "@/components/domKeyboardHost"

function hostProps(): Record<string, unknown> {
	render(createElement(DomKeyboardHost, { children: null }))

	return (keyboardAvoidingViewPropsSpy.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>
}

describe("DomKeyboardHost", () => {
	beforeEach(() => {
		keyboardAvoidingViewPropsSpy.mockClear()
		insets.left = 0
		insets.right = 0
	})

	it("arms a real avoidance behavior", () => {
		const props = hostProps()

		// The assertion that matters is NOT-undefined; the exact value is pinned so a change is a
		// deliberate one.
		expect(props["behavior"]).toBeDefined()
		expect(props["behavior"]).toBe("padding")
	})

	it("measures its own position in window coordinates", () => {
		// Without this the overlap comes from onLayout, whose y is PARENT-relative — every one of these
		// hosts sits under a header or inside a modal, so the padding would fall short by that offset.
		// Measuring the real position is also what makes the Android navigation bar a non-issue.
		expect(hostProps()["automaticOffset"]).toBe(true)
	})

	it("fills its parent, and lets a host add to that rather than replace it", () => {
		// The pdf viewer passes its own background; dropping flex-1 would collapse the WebView.
		render(createElement(DomKeyboardHost, { children: null, className: "bg-background" }))

		const className = String(keyboardAvoidingViewPropsSpy.mock.calls[0]?.[0]?.className ?? "")

		expect(className).toContain("flex-1")
		expect(className).toContain("bg-background")
	})

	it("stops the view short of the horizontal safe area", () => {
		// Landscape on a notched phone: that inset IS the sensor housing, and unlike the vertical ones
		// there is nothing to scroll under it. Insetting the VIEW rather than the page is what keeps the
		// docx viewer's white paper from rendering beneath the cutout — page padding leaves it there.
		insets.left = 59
		insets.right = 21

		const style = hostProps()["style"] as Record<string, number>

		expect(style["paddingLeft"]).toBe(59)
		expect(style["paddingRight"]).toBe(21)
	})

	it("costs nothing in portrait, where those insets are zero", () => {
		const style = hostProps()["style"] as Record<string, number>

		expect(style["paddingLeft"]).toBe(0)
		expect(style["paddingRight"]).toBe(0)
	})

	it("never insets vertically — that is what page padding is for", () => {
		// The whole point of the change: these hosts run edge to edge top-to-bottom so content can
		// scroll UNDER the overlaid header. A vertical view inset cannot express that.
		insets.left = 59
		insets.right = 21

		const style = hostProps()["style"] as Record<string, number | undefined>

		expect(style["paddingTop"]).toBeUndefined()
		expect(style["paddingBottom"]).toBeUndefined()
	})
})
