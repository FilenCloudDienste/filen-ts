import { lstatSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	LEGACY_EXECUTABLE,
	legacyLinkFpmMapping,
	listsLegacyExecutableLink,
	stageLegacyExecutableLink
} from "../../scripts/legacyExecutable.ts"

const dirs: string[] = []

function tempDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "filen-legacy-exe-"))

	dirs.push(dir)

	return dir
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true })
	}
})

describe("legacy Linux executable link", () => {
	it("stages a relative link to the executable, replacing an older one", () => {
		const dir = path.join(tempDir(), "opt")

		stageLegacyExecutableLink("Old", dir)
		stageLegacyExecutableLink("Filen", dir)

		const link = path.join(dir, LEGACY_EXECUTABLE)

		expect(lstatSync(link).isSymbolicLink()).toBe(true)
		expect(readlinkSync(link)).toBe("Filen")
	})

	it("finds the link in dpkg-deb and rpm listings", () => {
		const deb = [
			"drwxr-xr-x 0/0               0 2026-11-03 10:00 ./opt/Filen/",
			"-rwxr-xr-x 0/0       190000000 2026-11-03 10:00 ./opt/Filen/Filen",
			"lrwxrwxrwx 0/0               0 2026-11-03 10:00 ./opt/Filen/@filendesktop -> Filen"
		].join("\n")
		const rpm = "lrwxrwxrwx    1 root    root                        5 Nov  3 10:00 /opt/Filen/@filendesktop -> Filen\n"

		expect(listsLegacyExecutableLink(deb, "Filen")).toBe(true)
		expect(listsLegacyExecutableLink(rpm, "Filen")).toBe(true)
		expect(listsLegacyExecutableLink(deb, "Other")).toBe(false)
		expect(listsLegacyExecutableLink("-rwxr-xr-x 0/0 1 2026-11-03 10:00 ./opt/Filen/@filendesktop", "Filen")).toBe(false)
		expect(listsLegacyExecutableLink("lrwxrwxrwx 0/0 0 2026-11-03 10:00 ./opt/Filen/x/opt/Filen/@filendesktop -> Filen", "Filen")).toBe(
			false
		)
	})

	it("ships the link in the deb and rpm only, as their last fpm argument", async () => {
		const web = tempDir()

		writeFileSync(path.join(web, "index.html"), "")
		vi.stubEnv("FILEN_DESKTOP_WEB_DIST", web)

		const { default: config } = await import("../../electron-builder.ts")

		expect(legacyLinkFpmMapping.endsWith("/=/opt/Filen")).toBe(true)
		expect(config.deb?.fpm?.at(-1)).toBe(legacyLinkFpmMapping)
		expect(config.rpm?.fpm?.at(-1)).toBe(legacyLinkFpmMapping)
		expect(config.linux).not.toHaveProperty("fpm")
		expect(config.appImage).toBeUndefined()
		expect(config.linux?.executableName).toBe("Filen")
	})
})
