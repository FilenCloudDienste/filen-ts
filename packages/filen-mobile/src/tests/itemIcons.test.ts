import { vi, describe, it, expect, beforeEach } from "vitest"

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("@filen/shared", async () => {
	// Use the real isValidHexColor (pure fn, no native deps) and provide cn stub
	const { isValidHexColor } = await import("@filen/shared")

	// resolveFileIconKey pulls in @/lib/previewType for SDK_RAW_PREVIEW_EXTENSIONS, which builds its
	// own code-extension set from CODE_FILE_EXTENSIONS at module load — pull the real one through so
	// that import does not throw.
	const actual = await vi.importActual<typeof import("@filen/shared")>("@filen/shared")

	return {
		...(await import("@/tests/mocks/filenShared")),
		isValidHexColor,
		CODE_FILE_EXTENSIONS: actual.CODE_FILE_EXTENSIONS,
		cn: (...classes: (string | undefined | null | false)[]) => classes.filter(Boolean).join(" ")
	}
})

vi.mock("@filen/sdk-rs", () => ({
	DirColor_Tags: {
		Default: "Default",
		Blue: "Blue",
		Green: "Green",
		Purple: "Purple",
		Red: "Red",
		Gray: "Gray",
		Custom: "Custom"
	}
}))

// Stub require() calls for SVG assets in FILE_ICONS — the source uses
// require("@/components/itemIcons/svg/…"). These are mocked using the "@" alias form
// so vitest's mock system intercepts them before the CJS require() resolves.
vi.mock("@/components/itemIcons/svg/iso.svg", () => ({ default: "icon:iso" }))
vi.mock("@/components/itemIcons/svg/cad.svg", () => ({ default: "icon:cad" }))
vi.mock("@/components/itemIcons/svg/psd.svg", () => ({ default: "icon:psd" }))
vi.mock("@/components/itemIcons/svg/android.svg", () => ({ default: "icon:android" }))
vi.mock("@/components/itemIcons/svg/apple.svg", () => ({ default: "icon:apple" }))
vi.mock("@/components/itemIcons/svg/txt.svg", () => ({ default: "icon:txt" }))
vi.mock("@/components/itemIcons/svg/pdf.svg", () => ({ default: "icon:pdf" }))
vi.mock("@/components/itemIcons/svg/image.svg", () => ({ default: "icon:image" }))
vi.mock("@/components/itemIcons/svg/archive.svg", () => ({ default: "icon:archive" }))
vi.mock("@/components/itemIcons/svg/video.svg", () => ({ default: "icon:video" }))
vi.mock("@/components/itemIcons/svg/audio.svg", () => ({ default: "icon:audio" }))
vi.mock("@/components/itemIcons/svg/code.svg", () => ({ default: "icon:code" }))
vi.mock("@/components/itemIcons/svg/exe.svg", () => ({ default: "icon:exe" }))
vi.mock("@/components/itemIcons/svg/doc.svg", () => ({ default: "icon:doc" }))
vi.mock("@/components/itemIcons/svg/ppt.svg", () => ({ default: "icon:ppt" }))
vi.mock("@/components/itemIcons/svg/xls.svg", () => ({ default: "icon:xls" }))
vi.mock("@/components/itemIcons/svg/other.svg", () => ({ default: "icon:other" }))

// ExpoImage: not needed for pure-fn tests, but required so the module loads without error
vi.mock("@/components/ui/image", () => ({
	ExpoImage: () => null
}))

// es-toolkit/function memoize — use the real one (it's a pure JS function, safe in node)
// No mock needed.

// @/lib/previewType (SDK_RAW_PREVIEW_EXTENSIONS) and @/constants (EXPO_*_SUPPORTED_EXTENSIONS) load for
// real — both are pure data with no native-module dependency once react-native/expo-file-system are
// mocked above.

import { directoryColorToHex, shadeColor, unwrapDirColor, directorySvg, resolveFileIconKey } from "@/components/itemIcons/index"
import { DirColor_Tags } from "@filen/sdk-rs"
import { type DirColor } from "@filen/sdk-rs"

// ─────────────────────────────────────────────────────────────────────────────
// directoryColorToHex
// ─────────────────────────────────────────────────────────────────────────────

describe("directoryColorToHex", () => {
	it("maps named color 'blue' to lowercase '#037aff'", () => {
		expect(directoryColorToHex("blue")).toBe("#037aff")
	})

	it("maps named color 'gray' to '#8f8e93'", () => {
		expect(directoryColorToHex("gray")).toBe("#8f8e93")
	})

	it("maps named color 'green' to '#33c759'", () => {
		expect(directoryColorToHex("green")).toBe("#33c759")
	})

	it("maps named color 'purple' to '#af52de'", () => {
		expect(directoryColorToHex("purple")).toBe("#af52de")
	})

	it("maps named color 'red' to '#ff3b30'", () => {
		expect(directoryColorToHex("red")).toBe("#ff3b30")
	})

	it("returns default '#85BCFF' for null input", () => {
		expect(directoryColorToHex(null)).toBe("#85BCFF")
	})

	it("returns default '#85BCFF' for empty string ''", () => {
		expect(directoryColorToHex("")).toBe("#85BCFF")
	})

	it("lowercases and returns a valid 6-digit hex string '#AABBCC' -> '#aabbcc'", () => {
		expect(directoryColorToHex("#AABBCC")).toBe("#aabbcc")
	})

	it("returns lowercased default '#85bcff' for hex string without '#' prefix (e.g. 'AABBCC')", () => {
		// 'AABBCC' has no '#' so falls to default '#85BCFF' in the ternary, then .toLowerCase() → '#85bcff'
		// isValidHexColor('#85bcff') is true, so '#85bcff' is returned (not '#85BCFF')
		expect(directoryColorToHex("AABBCC")).toBe("#85bcff")
	})

	it("returns uppercase '#85BCFF' for invalid hex '#ZZZZZZ' (isValidHexColor guard triggers static return)", () => {
		// '#ZZZZZZ' includes '#' so hexColor = '#zzzzzz', isValidHexColor fails → returns the constant '#85BCFF'
		expect(directoryColorToHex("#ZZZZZZ")).toBe("#85BCFF")
	})

	it("returns lowercased default '#85bcff' for unknown named color 'orange'", () => {
		// 'orange' has no '#' → fallback '#85BCFF' in ternary → .toLowerCase() → '#85bcff' → valid → returned
		expect(directoryColorToHex("orange")).toBe("#85bcff")
	})

	it("returns lowercased default '#85bcff' for wrong-case named color 'DEFAULT'", () => {
		// Same path as 'orange' — no exact match, no '#' → '#85bcff'
		expect(directoryColorToHex("DEFAULT")).toBe("#85bcff")
	})

	it("returns uppercase '#85BCFF' for 3-digit hex '#ABC' (isValidHexColor length check triggers static return)", () => {
		// '#ABC' includes '#' → hexColor = '#abc' → isValidHexColor('#abc') is false (3-digit) → returns '#85BCFF'
		expect(directoryColorToHex("#ABC")).toBe("#85BCFF")
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// shadeColor
// ─────────────────────────────────────────────────────────────────────────────

describe("shadeColor", () => {
	it("darkens '#FF0000' with decimal 1.3 to '#c40000'", () => {
		// r = round(255/1.3) = 196 = 0xc4, g = 0, b = 0
		expect(shadeColor("#FF0000", 1.3)).toBe("#c40000")
	})

	it("returns '#ffffff' for pure white with decimal 1.0 (no change)", () => {
		expect(shadeColor("#FFFFFF", 1.0)).toBe("#ffffff")
	})

	it("returns '#000000' for pure black with any decimal", () => {
		expect(shadeColor("#000000", 1.3)).toBe("#000000")
		expect(shadeColor("#000000", 2.0)).toBe("#000000")
	})

	it("clamps channel value to 'ff' when result stays at 255 (decimal < 1 raises value)", () => {
		// decimal 0.5 → r = round(255 / 0.5) = 510 → clamped to 255 = 'ff'
		// g = round(128/0.5) = 256 → clamped to 255 = 'ff'; b = round(128/0.5) = 256 → 'ff'
		expect(shadeColor("#FF8080", 0.5)).toBe("#ffffff")
	})

	it("zero-pads single-hex-digit channel result (e.g. r=5 → '05')", () => {
		// '#050505' with decimal 1.0 → each channel stays 5 → '05'
		expect(shadeColor("#050505", 1.0)).toBe("#050505")
	})

	it("handles all channels independently: '#010203' with decimal 1.0 -> '#010203'", () => {
		expect(shadeColor("#010203", 1.0)).toBe("#010203")
	})

	it("decimal = 2.0 halves each channel: '#101010' -> '#080808'", () => {
		// round(16/2) = 8 = 0x08
		expect(shadeColor("#101010", 2.0)).toBe("#080808")
	})

	it("documents the no-# bug: '037AFF' extracts wrong channels (latent dead-code path)", () => {
		// Without '#', base = 0:
		//   r = parseInt("037AFF".substring(0, 3), 16) = parseInt("037", 16) = 55 = 0x37
		//   g = parseInt("037AFF".substring(2, 5), 16) = parseInt("7AF", 16) = 1967 → clamped to 255 = 0xff
		//   b = parseInt("037AFF".substring(4, 7), 16) = parseInt("AFF", 16) = 2815 → clamped to 255 = 0xff
		// This documents the invariant: no-# path produces incorrect/clamped output
		const result = shadeColor("037AFF", 1.0)

		expect(result).not.toBe("#037aff") // NOT the same as the '#'-prefixed version
		expect(result).toBe("#37ffff") // actual mangled output from broken substring offsets
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// unwrapDirColor
// ─────────────────────────────────────────────────────────────────────────────

describe("unwrapDirColor", () => {
	function makeDirColor(tag: string, inner?: [string]): DirColor {
		return (inner !== undefined ? { tag, inner } : { tag }) as unknown as DirColor
	}

	it("returns 'default' for undefined input", () => {
		expect(unwrapDirColor(undefined)).toBe("default")
	})

	it("returns 'default' for DirColor_Tags.Default tag", () => {
		expect(unwrapDirColor(makeDirColor(DirColor_Tags.Default))).toBe("default")
	})

	it("returns 'blue' for DirColor_Tags.Blue tag", () => {
		expect(unwrapDirColor(makeDirColor(DirColor_Tags.Blue))).toBe("blue")
	})

	it("returns 'gray' for DirColor_Tags.Gray tag", () => {
		expect(unwrapDirColor(makeDirColor(DirColor_Tags.Gray))).toBe("gray")
	})

	it("returns 'green' for DirColor_Tags.Green tag", () => {
		expect(unwrapDirColor(makeDirColor(DirColor_Tags.Green))).toBe("green")
	})

	it("returns 'purple' for DirColor_Tags.Purple tag", () => {
		expect(unwrapDirColor(makeDirColor(DirColor_Tags.Purple))).toBe("purple")
	})

	it("returns 'red' for DirColor_Tags.Red tag", () => {
		expect(unwrapDirColor(makeDirColor(DirColor_Tags.Red))).toBe("red")
	})

	it("returns inner[0] for DirColor_Tags.Custom tag with inner=['#AABB00']", () => {
		expect(unwrapDirColor(makeDirColor(DirColor_Tags.Custom, ["#AABB00"]))).toBe("#AABB00")
	})

	it("returns 'default' for unrecognized tag (falls through default branch)", () => {
		expect(unwrapDirColor(makeDirColor("UnknownTag"))).toBe("default")
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// directorySvg
// ─────────────────────────────────────────────────────────────────────────────

describe("directorySvg", () => {
	beforeEach(() => {
		// Clear the memoize cache between tests by reimporting (memoize cache persists
		// across the module instance — we rely on deterministic inputs per test instead).
	})

	it("null/undefined/default color uses hardcoded path1='#5398DF' and path2='#85BCFF'", () => {
		const uri = directorySvg({ color: null })
		const decoded = atob(uri.replace("data:image/svg+xml;base64,", ""))

		expect(decoded).toContain("#5398DF")
		expect(decoded).toContain("#85BCFF")
	})

	it("undefined color uses hardcoded path1='#5398DF' and path2='#85BCFF'", () => {
		const uri = directorySvg({ color: undefined })
		const decoded = atob(uri.replace("data:image/svg+xml;base64,", ""))

		expect(decoded).toContain("#5398DF")
		expect(decoded).toContain("#85BCFF")
	})

	it("'default' string color uses hardcoded path1='#5398DF' and path2='#85BCFF'", () => {
		const uri = directorySvg({ color: "default" })
		const decoded = atob(uri.replace("data:image/svg+xml;base64,", ""))

		expect(decoded).toContain("#5398DF")
		expect(decoded).toContain("#85BCFF")
	})

	it("'blue' color uses '#037aff' as path2 and shadeColor('#037aff', 1.3) as path1", () => {
		const uri = directorySvg({ color: "blue" })
		const decoded = atob(uri.replace("data:image/svg+xml;base64,", ""))
		const expectedPath2 = "#037aff"
		const expectedPath1 = shadeColor("#037aff", 1.3)

		expect(decoded).toContain(expectedPath2)
		expect(decoded).toContain(expectedPath1)
	})

	it("numeric width/height values produce e.g. '32px' suffix in the SVG output", () => {
		const uri = directorySvg({ color: null, width: 32, height: 32 })
		const decoded = atob(uri.replace("data:image/svg+xml;base64,", ""))

		expect(decoded).toContain('width="32px"')
		expect(decoded).toContain('height="32px"')
	})

	it("string width/height '64px' is used verbatim", () => {
		const uri = directorySvg({ color: null, width: "64px", height: "64px" })
		const decoded = atob(uri.replace("data:image/svg+xml;base64,", ""))

		expect(decoded).toContain('width="64px"')
		expect(decoded).toContain('height="64px"')
	})

	it("omitting width/height defaults to '32px'", () => {
		const uri = directorySvg({ color: null })
		const decoded = atob(uri.replace("data:image/svg+xml;base64,", ""))

		expect(decoded).toContain('width="32px"')
		expect(decoded).toContain('height="32px"')
	})

	it("same (color, width, height) called twice returns the same string reference (memoize cache hit)", () => {
		const first = directorySvg({ color: "blue", width: 48, height: 48 })
		const second = directorySvg({ color: "blue", width: 48, height: 48 })

		expect(first).toBe(second)
	})

	it("different color keys produce different SVG output strings", () => {
		const blue = directorySvg({ color: "blue", width: 32, height: 32 })
		const red = directorySvg({ color: "red", width: 32, height: 32 })

		expect(blue).not.toBe(red)
	})

	it("output is a valid data:image/svg+xml;base64,... URI", () => {
		const uri = directorySvg({ color: null })

		expect(uri.startsWith("data:image/svg+xml;base64,")).toBe(true)

		// The base64 payload must be non-empty and decodable
		const payload = uri.replace("data:image/svg+xml;base64,", "")

		expect(payload.length).toBeGreaterThan(0)
		expect(() => atob(payload)).not.toThrow()
	})

	it("SVG output contains both fill values for path1 and path2", () => {
		const uri = directorySvg({ color: "green", width: 32, height: 32 })
		const decoded = atob(uri.replace("data:image/svg+xml;base64,", ""))

		// Expect exactly two fill= attributes in the SVG (one per path)
		const fillMatches = decoded.match(/fill="[^"]+"/g)

		expect(fillMatches).not.toBeNull()
		expect(fillMatches!.length).toBe(2)
	})

	it("numeric vs string width produce different cache keys (and thus different SVG results for different numeric values)", () => {
		const numeric64 = directorySvg({ color: null, width: 64, height: 32 })
		const numeric32 = directorySvg({ color: null, width: 32, height: 32 })

		expect(numeric64).not.toBe(numeric32)
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// resolveFileIconKey — B39 diff-check
//
// B39 replaced FileIcon's old two-switch classification (a first switch keyed on getPreviewType with
// NO "code" case, falling through to a second, independently hand-maintained extname switch) with
// @filen/shared's fileIconKey. Every row below is the extension-by-extension diff against that old
// behavior, run under Platform.OS "ios" (the reactNative mock's default) so the EXPO_*_SUPPORTED_
// EXTENSIONS branches below resolve deterministically.
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveFileIconKey", () => {
	it("matches mobile's pre-B39 classification for every extension that did not change", () => {
		const UNCHANGED_CASES: [name: string, expected: string][] = [
			// image — via EXPO_IMAGE_SUPPORTED_EXTENSIONS
			["photo.png", "image"],
			["photo.jpg", "image"],
			["photo.jpeg", "image"],
			["photo.gif", "image"],
			["photo.webp", "image"],
			["photo.heic", "image"],
			["photo.bmp", "image"],
			["vector.svg", "image"],
			// image — the old extname-switch fallback, kept as its own fallback set (not in
			// EXPO_IMAGE_SUPPORTED_EXTENSIONS on either platform, or — .tiff — on Android only)
			["photo.jfif", "image"],
			["photo.jpe", "image"],
			["photo.tiff", "image"],
			// rawImage previewType — SDK_RAW_PREVIEW_EXTENSIONS, also collapses to the image glyph
			["shot.nef", "image"],
			["shot.cr3", "image"],
			["shot.dng", "image"],
			// video — via EXPO_VIDEO_SUPPORTED_EXTENSIONS (iOS)
			["clip.mp4", "video"],
			["clip.mov", "video"],
			["clip.m4v", "video"],
			// video — the old extname-switch fallback (not in iOS's EXPO_VIDEO_SUPPORTED_EXTENSIONS)
			["clip.wmv", "video"],
			["clip.avi", "video"],
			["clip.mkv", "video"],
			["clip.webm", "video"],
			// audio — via EXPO_AUDIO_SUPPORTED_EXTENSIONS (iOS)
			["song.mp3", "audio"],
			["song.m4a", "audio"],
			["song.aac", "audio"],
			["song.wav", "audio"],
			["song.aiff", "audio"],
			["song.caf", "audio"],
			// document / office
			["report.pdf", "pdf"],
			["notes.txt", "txt"],
			["a.doc", "doc"],
			["a.docx", "doc"],
			["deck.ppt", "ppt"],
			["deck.pptx", "ppt"],
			["sheet.xls", "xls"],
			["sheet.xlsx", "xls"],
			// disk images / design / platform packages — same icon asset, "apk"/"ipa" renamed to the
			// canonical "android"/"apple" FileIconKey members (FILE_ICONS still maps them to the same
			// android.svg/apple.svg)
			["disk.dmg", "iso"],
			["disk.iso", "iso"],
			["model.cad", "cad"],
			["art.psd", "psd"],
			["app.apk", "android"],
			["app.ipa", "apple"],
			// archive
			["bundle.pkg", "archive"],
			["bundle.rar", "archive"],
			["bundle.tar", "archive"],
			["bundle.zip", "archive"],
			["bundle.7zip", "archive"],
			// exe
			["app.jar", "exe"],
			["app.exe", "exe"],
			["app.bin", "exe"],
			// code — already correctly classified before B39 (mobile's old extname switch already
			// listed these, including the orphan .ahk entry)
			["main.ts", "code"],
			["main.rs", "code"],
			["main.py", "code"],
			["script.ahk", "code"],
			// unrecognised extension / no extension / undecryptable (empty name)
			["mystery.xyz", "other"],
			["noextension", "other"],
			["", "other"]
		]

		for (const [name, expected] of UNCHANGED_CASES) {
			expect(resolveFileIconKey(name)).toBe(expected)
		}
	})

	// The nine extensions whose icon changes from "other" to "code" as B39's documented side effect:
	// getPreviewType already classified these as "code" (previewType.ts consumes @filen/shared's
	// CODE_FILE_EXTENSIONS), but FileIcon's old first switch had no "code" case to consume that result,
	// and its second, independently hand-maintained extname switch never listed these eight — plus
	// "markdown" as the ninth (previewType.ts's own composed set already included it, but neither of
	// FileIcon's switches ever matched it either).
	it("fixes the eight extensions that used to fall through to 'other' (previewType.ts already called these code)", () => {
		const FIXED_CODE_EXTENSIONS = ["md", "log", "ini", "makefile", "mk", "gradle", "lua", "hpp"]

		for (const ext of FIXED_CODE_EXTENSIONS) {
			expect(resolveFileIconKey(`readme.${ext}`)).toBe("code")
		}
	})

	it("fixes the ninth extension, .markdown, the same way", () => {
		expect(resolveFileIconKey("readme.markdown")).toBe("code")
	})
})
