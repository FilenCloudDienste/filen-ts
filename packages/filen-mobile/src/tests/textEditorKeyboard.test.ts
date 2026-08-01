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

const { keyboardHostSpy } = vi.hoisted(() => ({
	keyboardHostSpy: vi.fn()
}))

// ─── Module boundary mocks (the editors themselves render nothing) ───────────

vi.mock("@/components/domKeyboardHost", () => ({
	default: (props: { children?: unknown }) => {
		keyboardHostSpy()

		return props.children ?? null
	}
}))

vi.mock("@/components/textEditor/dom", () => ({
	default: () => null
}))

vi.mock("@/components/textEditor/richText/dom", () => ({
	default: () => null
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
	})

	const types: TextEditorType[] = ["text", "code", "markdown", "richtext"]

	for (const type of types) {
		it(`wraps type="${type}" in the shared keyboard host`, () => {
			render(createElement(TextEditor, { initialValue: "hello", type }))

			expect(keyboardHostSpy).toHaveBeenCalled()
		})
	}
})
