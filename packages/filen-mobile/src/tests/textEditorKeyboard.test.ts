// @vitest-environment happy-dom

// Guards that the editors keep going through DomKeyboardHost (#102).
//
// DomKeyboardHost is what shrinks the WebView so its layout viewport ends at the keyboard; its own
// props are asserted in domKeyboardHost.test.ts. What is pinned here is that every editor branch
// still routes through it — they take different render paths, and only one of them tends to get
// exercised by hand.

import { vi, describe, it, expect, beforeEach } from "vitest"
import { createElement } from "react"
import { render } from "@testing-library/react"

const { keyboardHostSpy, domPropsSpy } = vi.hoisted(() => ({
	keyboardHostSpy: vi.fn(),
	domPropsSpy: vi.fn()
}))

// ─── Module boundary mocks (the editors themselves render nothing) ───────────

vi.mock("react-native-safe-area-context", async () => (await import("@/tests/mocks/textEditorHost")).safeAreaContext)

// Partially mocked: DOM_HOST_WEBVIEW_PROPS is the real object, since what the tests below check is
// that the editors actually forward it to the WebView.
vi.mock("@/components/domKeyboardHost", async importOriginal => {
	const actual = await importOriginal<typeof import("@/components/domKeyboardHost")>()

	return {
		...actual,
		default: (props: { children?: unknown }) => {
			keyboardHostSpy()

			return props.children ?? null
		}
	}
})

vi.mock("@/components/textEditor/dom", () => ({
	default: (props: { dom?: unknown }) => {
		domPropsSpy(props.dom)

		return null
	}
}))

vi.mock("@/components/textEditor/richText/dom", () => ({
	default: (props: { dom?: unknown }) => {
		domPropsSpy(props.dom)

		return null
	}
}))

vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

vi.mock("expo-router", () => ({
	useNavigation: () => ({
		addListener: () => () => {}
	})
}))

vi.mock("@/components/textEditor/initialValueCodec", async () => (await import("@/tests/mocks/textEditorHost")).initialValueCodec)

vi.mock("@/components/textEditor/markdownPreviewButton", async () => (await import("@/tests/mocks/textEditorHost")).markdownPreviewButton)

vi.mock("@/components/ui/view", async () => (await import("@/tests/mocks/textEditorHost")).uiView)

vi.mock("uniwind", async () => (await import("@/tests/mocks/textEditorHost")).uniwind)

vi.mock("@/lib/secureStore", async () => (await import("@/tests/mocks/textEditorHost")).secureStore)

vi.mock("@/stores/useRichtext.store", async () => (await import("@/tests/mocks/textEditorHost")).richtextStore)

vi.mock("@/stores/useTextEditor.store", async () => (await import("@/tests/mocks/textEditorHost")).textEditorStore)

vi.mock("@/hooks/useDomEvents/useNativeDomEvents", () => ({
	useNativeDomEvents: () => ({ onDomMessage: vi.fn(), postMessage: vi.fn() })
}))

vi.mock("@/hooks/useOpenExternalLink", async () => (await import("@/tests/mocks/textEditorHost")).useOpenExternalLink)

vi.mock("expo-linking", async () => (await import("@/tests/mocks/textEditorHost")).expoLinking)

vi.mock("@/lib/alerts", async () => await import("@/tests/mocks/alerts"))

vi.mock("@/lib/i18n", async () => await import("@/tests/mocks/i18n"))

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

// ─── Import component under test (after mocks) ───────────────────────────────

import { TextEditor, type TextEditorType } from "@/components/textEditor"

describe("TextEditor keyboard host (#102)", () => {
	beforeEach(() => {
		keyboardHostSpy.mockClear()
		domPropsSpy.mockClear()
	})

	const types: TextEditorType[] = ["text", "code", "markdown", "richtext"]

	for (const type of types) {
		it(`wraps type="${type}" in the shared keyboard host`, () => {
			render(createElement(TextEditor, { initialValue: "hello", type }))

			expect(keyboardHostSpy).toHaveBeenCalled()
		})

		it(`lets type="${type}" run edge to edge instead of inside the safe area`, () => {
			// iOS insets a WKWebView's scroll content by the safe area unless told otherwise, which put
			// bands above and below every preview that Android never had — and stacked with the page
			// padding these components already apply. The editors keep their content clear of the safe
			// area through that padding, which is also the only form of it content can scroll UNDER the
			// overlaid header.
			render(createElement(TextEditor, { initialValue: "hello", type }))

			expect(domPropsSpy).toHaveBeenCalledWith(expect.objectContaining({ contentInsetAdjustmentBehavior: "never" }))
		})
	}
})
