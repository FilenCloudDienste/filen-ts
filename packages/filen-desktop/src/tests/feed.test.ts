import { describe, expect, it } from "vitest"
import { parseFeed, rewriteFeed } from "../../scripts/feed.ts"

// The shape electron-builder 26 writes (js-yaml dump, two-space list indent, quoted ISO releaseDate), with the
// minimumSystemVersion line scripts/dist.ts prepends to the Mac manifest.
const mac = [
	"minimumSystemVersion: 21.0.0",
	"version: 4.0.0",
	"files:",
	"  - url: Filen_mac_x64.zip",
	"    sha512: macX64Zip==",
	"    size: 100",
	"  - url: Filen_mac_arm64.zip",
	"    sha512: macArm64Zip==",
	"    size: 200",
	"  - url: Filen_mac_x64.dmg",
	"    sha512: macX64Dmg==",
	"    size: 300",
	"  - url: Filen_mac_arm64.dmg",
	"    sha512: macArm64Dmg==",
	"    size: 400",
	"path: Filen_mac_x64.zip",
	"sha512: macX64Zip==",
	"releaseDate: '2026-11-18T10:00:00.000Z'",
	""
].join("\n")

const win = [
	"version: 4.0.0",
	"files:",
	"  - url: Filen_win.exe",
	"    sha512: winExe==",
	"    size: 500",
	"    isAdminRightsRequired: true",
	"path: Filen_win.exe",
	"sha512: winExe==",
	"releaseDate: '2026-11-18T10:00:00.000Z'",
	""
].join("\n")

const linux = [
	"version: 4.0.0",
	"files:",
	"  - url: Filen_linux_x86_64.AppImage",
	"    sha512: appImage==",
	"    size: 600",
	"  - url: Filen_linux_amd64.deb",
	"    sha512: deb==",
	"    size: 700",
	"  - url: Filen_linux_x86_64.rpm",
	"    sha512: rpm==",
	"    size: 800",
	"path: Filen_linux_x86_64.AppImage",
	"sha512: appImage==",
	'releaseDate: "2026-11-18T10:00:00.000Z"',
	""
].join("\n")

function hashesOf(text: string): Map<string, { sha512: string; size: number }> {
	return new Map(parseFeed(text, "fixture").files.map(file => [file.url, { sha512: file.sha512, size: file.size }]))
}

describe("parseFeed", () => {
	it("reads the Mac manifest with its prepended minimumSystemVersion and every file in order", () => {
		const feed = parseFeed(mac, "latest-mac.yml")

		expect([...feed.top]).toEqual([
			["minimumSystemVersion", "21.0.0"],
			["version", "4.0.0"],
			["files", ""],
			["path", "Filen_mac_x64.zip"],
			["sha512", "macX64Zip=="],
			["releaseDate", "2026-11-18T10:00:00.000Z"]
		])
		expect(feed.files).toEqual([
			{ url: "Filen_mac_x64.zip", sha512: "macX64Zip==", size: 100, isAdminRightsRequired: false },
			{ url: "Filen_mac_arm64.zip", sha512: "macArm64Zip==", size: 200, isAdminRightsRequired: false },
			{ url: "Filen_mac_x64.dmg", sha512: "macX64Dmg==", size: 300, isAdminRightsRequired: false },
			{ url: "Filen_mac_arm64.dmg", sha512: "macArm64Dmg==", size: 400, isAdminRightsRequired: false }
		])
	})

	it("reads isAdminRightsRequired from the Windows entry", () => {
		expect(parseFeed(win, "latest.yml").files).toEqual([
			{ url: "Filen_win.exe", sha512: "winExe==", size: 500, isAdminRightsRequired: true }
		])
	})

	it("reads the multi-file Linux manifest", () => {
		const feed = parseFeed(linux, "latest-linux.yml")

		expect(feed.files.map(file => file.url)).toEqual(["Filen_linux_x86_64.AppImage", "Filen_linux_amd64.deb", "Filen_linux_x86_64.rpm"])
		expect(feed.top.get("path")).toBe("Filen_linux_x86_64.AppImage")
	})

	it("unquotes single- and double-quoted values", () => {
		const feed = parseFeed(
			["version: '4.0.0'", "note: 'it''s'", "files:", '  - url: "Filen win.exe"', "    sha512: 'abc=='", "    size: 1", ""].join(
				"\n"
			),
			"latest.yml"
		)

		expect(feed.top.get("version")).toBe("4.0.0")
		expect(feed.top.get("note")).toBe("it's")
		expect(feed.files[0]).toMatchObject({ url: "Filen win.exe", sha512: "abc==" })
	})

	it("throws on a line outside the known shape", () => {
		expect(() => parseFeed(`${win}  nested:\n    - deep\n`, "latest.yml")).toThrow(/latest\.yml: unexpected line/)
		expect(() => parseFeed(`- stray\n${win}`, "latest.yml")).toThrow(/unexpected line "- stray"/)
	})

	it("throws when there are no files entries", () => {
		expect(() => parseFeed("version: 4.0.0\npath: Filen_win.exe\n", "latest.yml")).toThrow("latest.yml: no files entries")
	})

	it("throws when an entry lacks url, sha512 or size", () => {
		expect(() => parseFeed("version: 4.0.0\nfiles:\n  - url: a.exe\n    size: 1\n", "latest.yml")).toThrow(/lacks url, sha512 or size/)
		expect(() => parseFeed("version: 4.0.0\nfiles:\n  - url: a.exe\n    sha512: x\n    size: big\n", "latest.yml")).toThrow(
			/lacks url, sha512 or size/
		)
	})

	it("rejects a CRLF manifest instead of reading values with a trailing carriage return", () => {
		expect(() => parseFeed(win.replaceAll("\n", "\r\n"), "latest.yml")).toThrow(/unexpected line/)
	})
})

describe("rewriteFeed", () => {
	it("keeps the exact bytes when every hash matches", () => {
		for (const text of [mac, win, linux]) {
			expect(rewriteFeed(text, hashesOf(text))).toEqual({ text, changed: [] })
		}
	})

	it("leaves entries without a file on disk untouched", () => {
		expect(rewriteFeed(linux, new Map())).toEqual({ text: linux, changed: [] })
	})

	it("rewrites only the stale entry's sha512 and size when it is not the root path", () => {
		const actual = hashesOf(mac)

		actual.set("Filen_mac_arm64.dmg", { sha512: "fresh==", size: 401 })

		const result = rewriteFeed(mac, actual)

		expect(result.changed).toEqual(["Filen_mac_arm64.dmg"])
		expect(result.text).toBe(mac.replace("macArm64Dmg==", "fresh==").replace("size: 400", "size: 401"))
		expect(parseFeed(result.text, "latest-mac.yml").top.get("sha512")).toBe("macX64Zip==")
	})

	it("rewrites the root sha512 with the entry that path names", () => {
		const actual = hashesOf(win)

		actual.set("Filen_win.exe", { sha512: "fresh==", size: 501 })

		const result = rewriteFeed(win, actual)
		const feed = parseFeed(result.text, "latest.yml")

		expect(result.changed).toEqual(["Filen_win.exe"])
		expect(result.text).toBe(win.replaceAll("winExe==", "fresh==").replace("size: 500", "size: 501"))
		expect(feed.top.get("sha512")).toBe("fresh==")
		expect(feed.files[0]).toEqual({ url: "Filen_win.exe", sha512: "fresh==", size: 501, isAdminRightsRequired: true })
	})

	it("reports a size-only change", () => {
		const actual = hashesOf(linux)

		actual.set("Filen_linux_amd64.deb", { sha512: "deb==", size: 701 })

		const result = rewriteFeed(linux, actual)

		expect(result.changed).toEqual(["Filen_linux_amd64.deb"])
		expect(result.text).toBe(linux.replace("size: 700", "size: 701"))
	})

	it("throws on a manifest it cannot parse", () => {
		expect(() => rewriteFeed("version: 4.0.0\n", new Map())).toThrow("manifest: no files entries")
	})
})
