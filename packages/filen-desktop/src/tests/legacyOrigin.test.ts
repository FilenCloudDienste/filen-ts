import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { LEGACY_INDEXEDDB_PREFIX, legacyPageResponse, legacyProfileExists } from "../main/legacyOrigin.ts"

describe("legacyPageResponse", () => {
	it("serves an empty page that may load nothing at the root of the old origin", async () => {
		const response = legacyPageResponse("filendesktop://bundle/")

		expect(response.status).toBe(200)
		expect(response.headers.get("content-security-policy")).toBe("default-src 'none'")
		expect(await response.text()).not.toContain("<script")
	})

	it("serves nothing else", () => {
		expect(legacyPageResponse("filendesktop://bundle/index.html").status).toBe(404)
		expect(legacyPageResponse("filendesktop://bundle/assets/app.js").status).toBe(404)
		expect(legacyPageResponse("filendesktop://other/").status).toBe(404)
	})
})

describe("legacyProfileExists", () => {
	let userData: string

	beforeEach(async () => {
		userData = await realpath(await mkdtemp(path.join(tmpdir(), "filen-legacy-origin-")))
	})

	afterEach(async () => {
		await chmod(path.join(userData, "IndexedDB"), 0o700).catch(() => undefined)
		await rm(userData, { recursive: true, force: true })
	})

	// What Chromium creates for any profile on its first start.
	async function freshProfile(): Promise<void> {
		await mkdir(path.join(userData, "Local Storage", "leveldb"), { recursive: true })
		await writeFile(path.join(userData, "Local Storage", "leveldb", "CURRENT"), "MANIFEST-000001\n")
	}

	it("finds no old profile in a fresh one, the Local Storage store and another origin's IndexedDB included", async () => {
		await freshProfile()
		await mkdir(path.join(userData, "IndexedDB", "app_filen_0.indexeddb.leveldb"), { recursive: true })

		await expect(legacyProfileExists(userData)).resolves.toBe(false)
	})

	it("finds the old web app's IndexedDB", async () => {
		await freshProfile()
		await mkdir(path.join(userData, "IndexedDB", `${LEGACY_INDEXEDDB_PREFIX}indexeddb.leveldb`), { recursive: true })

		await expect(legacyProfileExists(userData)).resolves.toBe(true)
	})

	it("takes a file in its place, or in place of IndexedDB, as no old profile", async () => {
		await writeFile(path.join(userData, "IndexedDB"), "")
		await expect(legacyProfileExists(userData)).resolves.toBe(false)

		await rm(path.join(userData, "IndexedDB"))
		await mkdir(path.join(userData, "IndexedDB"))
		await writeFile(path.join(userData, "IndexedDB", `${LEGACY_INDEXEDDB_PREFIX}indexeddb.leveldb`), "")
		await expect(legacyProfileExists(userData)).resolves.toBe(false)
	})

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("rejects when it cannot tell", async () => {
		await mkdir(path.join(userData, "IndexedDB", `${LEGACY_INDEXEDDB_PREFIX}indexeddb.leveldb`), { recursive: true })
		await chmod(path.join(userData, "IndexedDB"), 0o000)

		await expect(legacyProfileExists(userData)).rejects.toMatchObject({ code: "EACCES" })
	})
})
