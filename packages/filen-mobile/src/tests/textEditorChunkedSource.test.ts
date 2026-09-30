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

const { domPropsSpy, nativePostMessageSpy } = vi.hoisted(() => ({
	domPropsSpy: vi.fn(),
	nativePostMessageSpy: vi.fn()
}))

vi.mock("react-native-safe-area-context", async () => (await import("@/tests/mocks/textEditorHost")).safeAreaContext)

vi.mock("@/components/textEditor/dom", () => ({
	default: (props: Record<string, unknown>) => {
		domPropsSpy(props)

		return null
	}
}))

vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

vi.mock("expo-router", () => ({
	useNavigation: () => ({
		addListener: () => () => {}
	})
}))

vi.mock("@/components/textEditor/richText/dom", () => ({
	default: () => null
}))

vi.mock("@/components/textEditor/initialValueCodec", async () => (await import("@/tests/mocks/textEditorHost")).initialValueCodec)

vi.mock("@/components/textEditor/markdownPreviewButton", async () => (await import("@/tests/mocks/textEditorHost")).markdownPreviewButton)

vi.mock("@/components/ui/view", async () => (await import("@/tests/mocks/textEditorHost")).uiView)

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

	it("arms no save handle for a read-only document", () => {
		// Deliberately NOT "offers no write RPC": `writeChunk` is still handed to a read-only WebView.
		// What stops a read-only document staging a file is useChunkedWriteTarget's armed-window gate
		// ("no save in progress"), not the absence of the prop — do not weaken that gate believing this
		// test covers it.
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
