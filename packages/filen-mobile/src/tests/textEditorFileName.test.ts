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

const { domPropsSpy, nativePostMessageSpy, beforeRemoveListeners, appStateListeners } = vi.hoisted(() => ({
	domPropsSpy: vi.fn(),
	nativePostMessageSpy: vi.fn(),
	beforeRemoveListeners: [] as Array<() => void>,
	appStateListeners: [] as Array<(state: string) => void>
}))

// ─── Module boundary mocks (child editors + heavy native deps render nothing) ─

vi.mock("react-native-safe-area-context", async () => (await import("@/tests/mocks/textEditorHost")).safeAreaContext)

vi.mock("@/components/textEditor/dom", () => ({
	default: (props: Record<string, unknown>) => {
		domPropsSpy(props)

		return null
	}
}))

// The wrapper owns the chunked-document write target, which stages a save to a temp file.
vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

// The wrapper now subscribes to beforeRemove for the content-flush belt (#67) — stub the
// navigator surface it needs (expo-router's source is untranspilable in vitest).
vi.mock("expo-router", () => ({
	useNavigation: () => ({
		addListener: (event: string, listener: () => void) => {
			if (event === "beforeRemove") {
				beforeRemoveListeners.push(listener)
			}

			return () => {}
		}
	})
}))

vi.mock("@/components/textEditor/richText/dom", () => ({
	default: () => null
}))

vi.mock("@/components/textEditor/initialValueCodec", async () => (await import("@/tests/mocks/textEditorHost")).initialValueCodec)

vi.mock("@/components/textEditor/markdownPreviewButton", async () => (await import("@/tests/mocks/textEditorHost")).markdownPreviewButton)

vi.mock("@/components/ui/view", async () => (await import("@/tests/mocks/textEditorHost")).uiView)

vi.mock("react-native", () => ({
	Platform: { OS: "ios", select: (o: Record<string, unknown>) => o["ios"] ?? o["default"] },
	AppState: {
		currentState: "active",
		addEventListener: (_type: string, listener: (state: string) => void) => {
			appStateListeners.push(listener)

			return { remove: () => {} }
		}
	}
}))

vi.mock("uniwind", async () => (await import("@/tests/mocks/textEditorHost")).uniwind)

vi.mock("@/lib/secureStore", async () => (await import("@/tests/mocks/textEditorHost")).secureStore)

vi.mock("@/stores/useRichtext.store", async () => (await import("@/tests/mocks/textEditorHost")).richtextStore)

vi.mock("@/stores/useTextEditor.store", async () => (await import("@/tests/mocks/textEditorHost")).textEditorStore)

vi.mock("@/hooks/useDomEvents/useNativeDomEvents", () => ({
	useNativeDomEvents: () => ({ onDomMessage: vi.fn(), postMessage: nativePostMessageSpy })
}))

vi.mock("@/hooks/useOpenExternalLink", async () => (await import("@/tests/mocks/textEditorHost")).useOpenExternalLink)

vi.mock("expo-linking", async () => (await import("@/tests/mocks/textEditorHost")).expoLinking)

vi.mock("@/lib/alerts", async () => await import("@/tests/mocks/alerts"))

vi.mock("@/lib/i18n", async () => await import("@/tests/mocks/i18n"))

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

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

// ─── #67 flush-belt wiring: the wrapper asks the DOM side to flush pending content ───

describe("TextEditor content-flush triggers (#67)", () => {
	beforeEach(() => {
		nativePostMessageSpy.mockClear()
		beforeRemoveListeners.length = 0
		appStateListeners.length = 0
	})

	it("posts a composition-committing flush when the screen starts leaving", () => {
		renderEditor({ type: "text" })

		expect(beforeRemoveListeners).toHaveLength(1)

		beforeRemoveListeners[0]?.()

		expect(nativePostMessageSpy).toHaveBeenCalledWith({
			type: "flushContent",
			data: { commitComposition: true }
		})
	})

	it("posts a committing flush on background and a SOFT (no-blur) flush on inactive", () => {
		renderEditor({ type: "text" })

		expect(appStateListeners).toHaveLength(1)

		appStateListeners[0]?.("background")

		expect(nativePostMessageSpy).toHaveBeenCalledWith({
			type: "flushContent",
			data: { commitComposition: true }
		})

		nativePostMessageSpy.mockClear()
		// iOS "inactive" (notification shade / app switcher): never blur — the user may keep
		// typing right after; the soft flush still rescues a doc-committed-but-events-lost edit
		// before a switcher swipe-kill.
		appStateListeners[0]?.("inactive")

		expect(nativePostMessageSpy).toHaveBeenCalledWith({
			type: "flushContent",
			data: { commitComposition: false }
		})

		nativePostMessageSpy.mockClear()
		appStateListeners[0]?.("active")

		expect(nativePostMessageSpy).not.toHaveBeenCalled()
	})

	it("subscribes nothing for a read-only editor", () => {
		render(createElement(TextEditor, { initialValue: "x", type: "text", readOnly: true }))

		expect(beforeRemoveListeners).toHaveLength(0)
		expect(appStateListeners).toHaveLength(0)
	})
})
