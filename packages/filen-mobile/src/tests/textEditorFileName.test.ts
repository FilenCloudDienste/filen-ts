// @vitest-environment happy-dom

// Guards the fileName wiring: TextEditor (the wrapper) must forward its `fileName`
// prop to TextEditorDOM, which derives the CodeMirror language from it via
// loadLanguage(fileName ?? "file.tsx"). Before the fix the wrapper neither declared
// nor forwarded `fileName`, so every previewed code file (.py/.rs/.go/.sql/...) was
// highlighted as TSX. We mock TextEditorDOM to capture the props it actually receives.

import { vi, describe, it, expect, beforeEach } from "vitest"
import { createElement } from "react"
import { render } from "@testing-library/react"

// ─── Capture spy for the props TextEditorDOM receives ────────────────────────

const { domPropsSpy } = vi.hoisted(() => ({
	domPropsSpy: vi.fn()
}))

// ─── Module boundary mocks (child editors + heavy native deps render nothing) ─

vi.mock("@/components/textEditor/dom", () => ({
	default: (props: Record<string, unknown>) => {
		domPropsSpy(props)

		return null
	}
}))

vi.mock("@/components/textEditor/richText/dom", () => ({
	default: () => null
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
	Platform: { OS: "ios", select: (o: Record<string, unknown>) => o["ios"] ?? o["default"] }
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

import { TextEditor } from "@/components/textEditor"

function renderEditor(props: { type: "code" | "text"; fileName?: string }) {
	render(createElement(TextEditor, { initialValue: "print('hi')", ...props }))
}

describe("TextEditor forwards fileName to TextEditorDOM", () => {
	beforeEach(() => {
		domPropsSpy.mockClear()
	})

	it("passes a code file's real name through (so loadLanguage picks its language, not the tsx default)", () => {
		renderEditor({ type: "code", fileName: "main.py" })

		expect(domPropsSpy).toHaveBeenCalled()
		expect(domPropsSpy.mock.calls[0]?.[0]).toMatchObject({ type: "code", fileName: "main.py" })
	})

	it("forwards fileName for a text file too", () => {
		renderEditor({ type: "text", fileName: "notes.rs" })

		expect(domPropsSpy.mock.calls[0]?.[0]).toMatchObject({ fileName: "notes.rs" })
	})

	it("passes undefined through when no fileName is given (unchanged default behavior)", () => {
		renderEditor({ type: "code" })

		expect(domPropsSpy.mock.calls[0]?.[0]).toHaveProperty("fileName", undefined)
	})
})
