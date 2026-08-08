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

// DomKeyboardHost reads the horizontal safe area to stop the WebView short of the sensor housing.
vi.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))

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

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))
vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

vi.mock("expo-router", () => ({
	useNavigation: () => ({
		addListener: () => () => {}
	})
}))

vi.mock("@/components/textEditor/initialValueCodec", () => ({
	encodeEditorInitialValue: (v: string) => v
}))

vi.mock("@/components/textEditor/markdownPreviewButton", () => ({
	default: () => null
}))

vi.mock("@/components/ui/view", () => ({
	default: ({ children }: { children?: unknown }) => children ?? null,
	KeyboardAvoidingView: ({ children }: { children?: unknown }) => children ?? null
}))

vi.mock("react-native", () => ({
	Platform: { OS: "ios", select: (o: Record<string, unknown>) => o["ios"] ?? o["default"] },
	AppState: {
		currentState: "active",
		addEventListener: () => ({ remove: () => {} })
	}
}))

vi.mock("uniwind", () => ({
	useResolveClassNames: () => ({ color: "#000000", backgroundColor: "#000000", fontFamily: "sans", fontSize: 14, fontWeight: 400 }),
	useUniwind: () => ({ theme: "dark" })
}))

vi.mock("@/lib/secureStore", () => ({
	useSecureStore: (_key: string, initial: unknown) => [initial, vi.fn()]
}))

vi.mock("@/stores/useRichtext.store", () => ({
	default: { getState: () => ({ setFormats: vi.fn() }) }
}))

vi.mock("@/stores/useTextEditor.store", () => ({
	default: { getState: () => ({ setReady: vi.fn(), setDispatch: vi.fn() }) }
}))

vi.mock("@/hooks/useDomEvents/useNativeDomEvents", () => ({
	useNativeDomEvents: () => ({ onDomMessage: vi.fn(), postMessage: vi.fn() })
}))

vi.mock("@/hooks/useOpenExternalLink", () => ({
	default: () => async () => {}
}))

vi.mock("expo-linking", () => ({
	canOpenURL: vi.fn(),
	openURL: vi.fn()
}))

vi.mock("@/lib/alerts", () => ({
	default: { error: vi.fn() }
}))

vi.mock("@/lib/i18n", () => ({
	default: { t: (k: string) => k }
}))

vi.mock("@/lib/logger", () => ({
	default: { error: vi.fn(), warn: vi.fn() }
}))

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
