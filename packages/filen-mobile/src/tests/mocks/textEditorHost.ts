/**
 * Spy-free module-boundary stubs shared by the suites that render <TextEditor>. One export per mocked
 * module; each suite keeps its spy-bearing mocks inline.
 *
 *   vi.mock("uniwind", async () => (await import("@/tests/mocks/textEditorHost")).uniwind)
 */

import { vi } from "vitest"

// DomKeyboardHost reads the horizontal safe area to stop the WebView short of the sensor housing.
export const safeAreaContext = {
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}

export const initialValueCodec = {
	encodeEditorInitialValue: (v: string) => v
}

export const markdownPreviewButton = {
	default: () => null
}

export const uiView = {
	default: ({ children }: { children?: unknown }) => children ?? null,
	KeyboardAvoidingView: ({ children }: { children?: unknown }) => children ?? null
}

export const uniwind = {
	useResolveClassNames: () => ({ color: "#000000", backgroundColor: "#000000", fontFamily: "sans", fontSize: 14, fontWeight: 400 }),
	useUniwind: () => ({ theme: "dark" })
}

export const secureStore = {
	useSecureStore: (_key: string, initial: unknown) => [initial, vi.fn()]
}

export const richtextStore = {
	default: { getState: () => ({ setFormats: vi.fn() }) }
}

export const textEditorStore = {
	default: { getState: () => ({ setReady: vi.fn(), setDispatch: vi.fn() }) }
}

// Keeps the suites off @/lib/prompts -> the native alert module, which has no ESM entry under vitest.
export const useOpenExternalLink = {
	default: () => async () => {}
}

export const expoLinking = {
	canOpenURL: vi.fn(),
	openURL: vi.fn()
}
