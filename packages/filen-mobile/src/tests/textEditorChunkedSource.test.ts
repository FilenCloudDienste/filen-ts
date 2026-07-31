// @vitest-environment happy-dom

// Guards the chunked-document wiring between TextEditor (the wrapper) and TextEditorDOM.
//
// The load-bearing assertion is that readRange/writeChunk arrive as TOP-LEVEL props. expo/dom's
// marshaller only treats a top-level prop as a callable native action (webview-wrapper's
// `value instanceof Function` check); a function nested inside an object prop is JSON-serialized
// away to undefined instead. That failure is silent — no type error, no exception, just a viewer
// that never loads and never saves — so it is pinned here.

import { vi, describe, it, expect, beforeEach } from "vitest"
import { createElement } from "react"
import { render } from "@testing-library/react"

const { domPropsSpy, nativePostMessageSpy, appStateListeners } = vi.hoisted(() => ({
	domPropsSpy: vi.fn(),
	nativePostMessageSpy: vi.fn(),
	appStateListeners: [] as Array<(state: string) => void>
}))

vi.mock("@/components/textEditor/dom", () => ({
	default: (props: Record<string, unknown>) => {
		domPropsSpy(props)

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
	Platform: { OS: "ios", select: (o: Record<string, unknown>) => o["ios"] ?? o["default"] },
	AppState: {
		currentState: "active",
		addEventListener: (_type: string, listener: (state: string) => void) => {
			appStateListeners.push(listener)

			return { remove: () => {} }
		}
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
	useNativeDomEvents: () => ({ onDomMessage: vi.fn(), postMessage: nativePostMessageSpy })
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

import { TextEditor } from "@/components/textEditor"
import type { File } from "expo-file-system"

const readRange = async () => ""

function props() {
	return domPropsSpy.mock.calls[0]?.[0] as Record<string, unknown>
}

describe("TextEditor chunked-document mode", () => {
	beforeEach(() => {
		domPropsSpy.mockClear()
	})

	it("forwards the transfer functions as top-level props, never nested", () => {
		render(
			createElement(TextEditor, {
				type: "code",
				readRange,
				fileSize: 1234,
				saveHandleRef: { current: null }
			})
		)

		expect(typeof props()["readRange"]).toBe("function")
		expect(typeof props()["writeChunk"]).toBe("function")
		expect(props()["fileSize"]).toBe(1234)
	})

	it("does not ship the document as a prop when a reader is supplied", () => {
		// The whole point: expo/dom re-serializes props into an injected JS source string on every
		// render of the host, so a document-sized prop is re-encoded and re-parsed continuously.
		render(
			createElement(TextEditor, {
				type: "code",
				initialValue: "this must not cross as a prop",
				readRange,
				fileSize: 10
			})
		)

		expect(props()["initialValue"]).toBe("")
	})

	it("leaves the plain-string path untouched when no reader is supplied", () => {
		// Notes take this path: their content comes from a query rather than a file, and their sync
		// needs every change, so they keep initialValue + onValueChange.
		const onValueChange = vi.fn()

		render(
			createElement(TextEditor, {
				type: "markdown",
				initialValue: "# note",
				onValueChange
			})
		)

		expect(props()["initialValue"]).toBe("# note")
		expect(props()["onValueChange"]).toBe(onValueChange)
		expect(props()["readRange"]).toBeUndefined()
		// No write RPC is offered, so nothing in that WebView can stage a file.
		expect(props()["writeChunk"]).toBeUndefined()
	})

	it("offers no write RPC for a read-only document", () => {
		const saveHandleRef: { current: (() => Promise<File | null>) | null } = { current: null }

		render(
			createElement(TextEditor, {
				type: "code",
				readRange,
				fileSize: 10,
				readOnly: true,
				saveHandleRef
			})
		)

		expect(saveHandleRef.current).toBeNull()
	})

	it("arms a save handle for a writable document", () => {
		const saveHandleRef: { current: (() => Promise<File | null>) | null } = { current: null }

		render(
			createElement(TextEditor, {
				type: "code",
				readRange,
				fileSize: 10,
				saveHandleRef
			})
		)

		expect(typeof saveHandleRef.current).toBe("function")
	})
})
