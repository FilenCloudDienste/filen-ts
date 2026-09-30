// @vitest-environment happy-dom

// Pins which CodeMirror language TextEditorDOM loads. Markdown notes pass no fileName, and used to
// fall back to the TSX grammar; they must get the markdown grammar drive .md files already get.

import { vi, describe, it, expect, beforeEach } from "vitest"
import { createElement } from "react"
import { render } from "@testing-library/react"

const { loadLanguageSpy } = vi.hoisted(() => ({
	loadLanguageSpy: vi.fn((_name: string) => null)
}))

vi.mock("@uiw/react-md-editor/markdown-editor.css", () => ({}))

vi.mock("@uiw/react-markdown-preview/markdown.css", () => ({}))

vi.mock("expo/dom", () => ({
	useDOMImperativeHandle: () => {}
}))

vi.mock("@uiw/react-codemirror", async importOriginal => ({
	...(await importOriginal<typeof import("@uiw/react-codemirror")>()),
	default: () => null
}))

vi.mock("@uiw/codemirror-theme-xcode", () => ({
	xcodeLight: {},
	xcodeDark: {}
}))

vi.mock("@uiw/codemirror-theme-material", () => ({
	materialLight: {},
	materialDark: {}
}))

vi.mock("@uiw/react-md-editor", () => ({
	default: {
		Markdown: () => null
	}
}))

vi.mock("@/components/textEditor/codeMirror", async importOriginal => ({
	...(await importOriginal<typeof import("@/components/textEditor/codeMirror")>()),
	loadLanguage: loadLanguageSpy
}))

vi.mock("@/hooks/useDomEvents/useDomDomEvents", () => ({
	default: () => ({
		onNativeMessage: () => {},
		postMessage: () => {}
	})
}))

vi.mock("@/hooks/useDomEvents/domConsoleProxy", () => ({
	installDomConsoleProxy: () => {}
}))

vi.mock("@/lib/domViewport", async importOriginal => ({
	...(await importOriginal<typeof import("@/lib/domViewport")>()),
	installDomViewportReset: () => {}
}))

import TextEditorDOM from "@/components/textEditor/dom"
import type { TextEditorType } from "@/components/textEditor"

function renderEditor(type: TextEditorType, fileName?: string) {
	render(
		createElement(TextEditorDOM, {
			ref: null,
			darkMode: false,
			platform: "ios",
			type,
			fileName
		})
	)
}

describe("TextEditorDOM language", () => {
	beforeEach(() => {
		loadLanguageSpy.mockClear()
	})

	it("loads the markdown grammar for a markdown note without a fileName", () => {
		renderEditor("markdown")

		expect(loadLanguageSpy).toHaveBeenCalledWith("file.md")
		expect(loadLanguageSpy).not.toHaveBeenCalledWith("file.tsx")
	})

	it("keeps the TSX default for a code note without a fileName", () => {
		renderEditor("code")

		expect(loadLanguageSpy).toHaveBeenCalledWith("file.tsx")
	})

	it("uses the real fileName when one is passed", () => {
		renderEditor("markdown", "notes.py")

		expect(loadLanguageSpy).toHaveBeenCalledWith("notes.py")
	})
})
