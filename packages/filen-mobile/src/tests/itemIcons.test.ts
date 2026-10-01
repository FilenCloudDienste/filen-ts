import { vi, describe, it, expect, beforeEach } from "vitest"

vi.mock("@filen/shared", async () => ({
	...(await import("@/tests/mocks/filenShared")),
	cn: (...classes: (string | undefined | null | false)[]) => classes.filter(Boolean).join(" ")
}))

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

// Image: not needed for pure-fn tests, but required so the module loads without error
vi.mock("@/components/ui/image", () => ({
	default: () => null,
	Image: () => null
}))

// es-toolkit/function memoize — use the real one (it's a pure JS function, safe in node)
// No mock needed.

// @/lib/previewType (SDK_RAW_PREVIEW_EXTENSIONS) and @/constants (EXPO_*_SUPPORTED_EXTENSIONS) load for
// real — both are pure data with no native-module dependency once react-native/expo-file-system are
// mocked above.

import { unwrapDirColor, directorySvg, resolveFileIconKey } from "@/components/itemIcons/index"
import { Paths } from "expo-file-system"
import { DirColor_Tags } from "@filen/sdk-rs"
import { type DirColor } from "@filen/sdk-rs"

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

	it("'blue' color uses '#037AFF' as path2 and its darker tab shade as path1", () => {
		const uri = directorySvg({ color: "blue" })
		const decoded = atob(uri.replace("data:image/svg+xml;base64,", ""))

		expect(decoded).toContain('fill="#037AFF"')
		expect(decoded).toContain('fill="#025ec4"')
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

	// Paths.extname parses the name as a URL first; for a name without a scheme that throws and is caught
	// on every call, and this runs per icon bind. A file name is not a URL, colon or not.
	it("never calls Paths.extname, and parses a colon-bearing name as a plain name", () => {
		const extname = vi.spyOn(Paths, "extname")
		const keys = ["IMG_0001.HEIC", "song.mp3", "report.pdf", "notes.txt", "noextension", ".jpg", "clip 12:30.mp4"].map(name =>
			resolveFileIconKey(name)
		)

		// Same parse as before: a leading-dot name like ".jpg" has no extension.
		expect(keys).toEqual(["image", "audio", "pdf", "txt", "other", "other", "video"])
		expect(extname).not.toHaveBeenCalled()

		extname.mockRestore()
	})

	// The icon reads the same type extension as the preview: a well-known name, then the stored mime.
	it("icons a well-known extension-less name by what it is", () => {
		expect(resolveFileIconKey("LICENSE")).toBe("txt")
		expect(resolveFileIconKey(".gitignore")).toBe("txt")
		expect(resolveFileIconKey("Makefile")).toBe("code")
		expect(resolveFileIconKey("Dockerfile")).toBe("code")
		expect(resolveFileIconKey(".bashrc")).toBe("code")
	})

	it("icons a file with no or an unknown extension by its stored mime", () => {
		expect(resolveFileIconKey("clip", "video/mp4")).toBe("video")
		expect(resolveFileIconKey("scan.data", "application/pdf")).toBe("pdf")
		expect(resolveFileIconKey("notes.cfg", "text/plain; charset=utf-8")).toBe("txt")
		expect(resolveFileIconKey("blob", "application/octet-stream")).toBe("other")
	})

	it("keeps a known extension's icon whatever the mime says", () => {
		expect(resolveFileIconKey("photo.jpg", "video/mp4")).toBe("image")
		expect(resolveFileIconKey("main.rs", "text/plain")).toBe("code")
	})
})
