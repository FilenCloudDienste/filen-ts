import type { Page } from "@playwright/test"

// Meta on macOS (where this suite runs today), Control elsewhere — a plain host-platform proxy. Only
// safe for interactions that don't go through either in-page "mod" resolution below (e.g. a raw
// click-with-modifiers multi-select), since Playwright's chromium device profile fakes its own
// userAgent/platform regardless of the actual host.
export const MOD_KEY = process.platform === "darwin" ? "Meta" : "Control"

// react-hotkeys-hook resolves the "mod" pseudo-modifier from the PAGE's own navigator.userAgent
// (its internal isMac() check: /mac/i against the UA, iOS excluded), never from the real host OS.
// process.platform (the Node/Playwright-runner's host) is not a reliable proxy for that: Playwright's
// chromium "Desktop Chrome" device profile ships a fixed userAgent that reports Windows regardless of
// the machine it actually runs on (verified against playwright-core's own device descriptor source).
// On a macOS runner this desyncs the two Mac checks — the test would send Meta, the in-page library
// would still expect Ctrl for "mod" — so a keymap.v1-registered "mod+…" combo never matches and the
// keydown falls through to the browser's own default action instead. Asking the page the same
// question the library asks itself is the only way to pick a key that will actually match. Use this
// resolver for any react-hotkeys-hook-registered app action (mod+f/mod+s/etc.).
export async function resolveModKey(page: Page): Promise<"Meta" | "Control"> {
	const looksLikeMacToBrowser = await page.evaluate(
		() => /mac/i.test(navigator.userAgent) && !/iphone|ipad|ipod/i.test(navigator.userAgent)
	)

	return looksLikeMacToBrowser ? "Meta" : "Control"
}

// Deliberately NOT resolveModKey's own userAgent-based check — this resolver exists for interactions
// that drive CodeMirror's OWN built-in keymap (e.g. `Mod-a` inside `.cm-content`), never a
// react-hotkeys-hook-registered app action, and the two libraries resolve "mac" from different
// navigator properties that disagree under Playwright's chromium device emulation. react-hotkeys-hook
// (what resolveModKey above correctly targets) checks navigator.userAgent, which Playwright's
// "Desktop Chrome" profile fakes as Windows regardless of host. CodeMirror's keymap (@codemirror/view,
// `mac: ios || /Mac/.test(nav.platform)` — verified in the installed package source) checks
// navigator.platform instead, which that same profile leaves truthful. On a macOS host the two
// disagree: userAgent says "not mac" (Control), platform says "mac" (Meta) — reusing the userAgent-
// based resolver here would send Control-a into the editor, which CodeMirror doesn't bind to
// select-all, so nothing gets selected and a following keyboard.type() would INSERT at the
// click-positioned caret instead of replacing the buffer — silently corrupting the saved content into
// a mix of old and new text. Use this resolver only for CodeMirror-native keybindings.
export async function resolveEditorModKey(page: Page): Promise<"Meta" | "Control"> {
	const looksLikeMacToCodeMirror = await page.evaluate(() => navigator.platform.includes("Mac"))

	return looksLikeMacToCodeMirror ? "Meta" : "Control"
}
