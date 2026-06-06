import { vi, describe, it, expect, beforeEach } from "vitest"

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))
vi.mock("expo-crypto", async () => await import("@/tests/mocks/expoCrypto"))

import { fs } from "@/tests/mocks/expoFileSystem"
import { resetUUIDCounter } from "@/tests/mocks/expoCrypto"

// Import the real unit under test — we do NOT mock it.
// We need to reset module-level state (ensured flag) between tests.
// The cleanest way: use vi.resetModules() + dynamic re-import in each test
// that needs fresh state. For tests that operate on the already-imported
// module (e.g. multiple calls in sequence) we simply re-import after reset.

beforeEach(() => {
	fs.clear()
	resetUUIDCounter()
	vi.resetModules()
})

async function freshTmp() {
	return import("@/lib/tmp")
}

describe("sweepTmpDir", () => {
	it("when directory does not exist, returns without creating it", async () => {
		const { sweepTmpDir } = await freshTmp()

		// Directory has never been created in the in-memory FS → exists === false
		expect(() => sweepTmpDir()).not.toThrow()

		// No directory should have been created as a side-effect
		const anyDirEntries = [...fs.entries()].filter(([, v]) => v === "dir")

		expect(anyDirEntries).toHaveLength(0)
	})

	it("when directory exists, deletes all children and recreates the directory", async () => {
		const { sweepTmpDir, newTmpFile } = await freshTmp()

		// Trigger lazy creation, then add a file inside tmp
		const file = newTmpFile("stale.bin")
		file.write(new Uint8Array([1, 2, 3]))

		expect(file.exists).toBe(true)

		sweepTmpDir()

		// Stale file must be gone
		expect(file.exists).toBe(false)

		// After sweep, the directory must have been recreated (ensure() called)
		const tmpPath = file.uri.replace(/\/[^/]+$/, "")
		const { Directory } = await import("expo-file-system")
		const tmpDir = new Directory(tmpPath)

		expect(tmpDir.exists).toBe(true)
	})

	it("calling sweepTmpDir() twice in sequence is idempotent", async () => {
		const { sweepTmpDir, newTmpFile } = await freshTmp()

		// Create a file so the directory is initialised
		newTmpFile("touch.bin")

		expect(() => {
			sweepTmpDir()
			sweepTmpDir()
		}).not.toThrow()
	})

	it("after sweepTmpDir() newTmpFile() returns a handle inside the freshly-created tmp dir", async () => {
		const { sweepTmpDir, newTmpFile, TMP_DIR_NAME } = await freshTmp()

		// Bootstrap the directory
		newTmpFile("bootstrap.txt")

		sweepTmpDir()

		// ensured was reset to false — ensure() should run again
		const file = newTmpFile("post-sweep.txt")

		expect(file.uri).toContain(TMP_DIR_NAME)
	})

	it("if directory.delete() throws, ensured is reset and ensure() recreates the dir", async () => {
		const { sweepTmpDir, newTmpFile, TMP_DIR_NAME } = await freshTmp()

		// Bootstrap the directory
		newTmpFile("initial.bin")

		// Patch the mock Directory's delete() to throw once
		const { Directory } = await import("expo-file-system")
		const originalDelete = Directory.prototype.delete
		let threw = false

		Directory.prototype.delete = function () {
			if (!threw) {
				threw = true
				throw new Error("delete failed")
			}
			originalDelete.call(this)
		}

		try {
			expect(() => sweepTmpDir()).not.toThrow()
		} finally {
			Directory.prototype.delete = originalDelete
		}

		// Even though delete threw, ensured must have been reset to false so that
		// ensure() ran and actually recreated the directory on disk — not just
		// constructed a URI. Assert directory.exists===true, not just the path prefix.
		const file = newTmpFile("recovery.bin")
		const tmpPath = file.uri.replace(/\/[^/]+$/, "")
		const tmpDir = new Directory(tmpPath)

		expect(file.uri).toContain(TMP_DIR_NAME)
		expect(tmpDir.exists).toBe(true)
	})
})

describe("newTmpFile / newTmpDir / ensure", () => {
	it("newTmpFile() with no argument returns a File URI inside filen-tmp with a UUID-shaped name", async () => {
		const { newTmpFile, TMP_DIR_NAME } = await freshTmp()
		const file = newTmpFile()

		expect(file.uri).toContain(TMP_DIR_NAME)
		// expoCrypto mock produces "mock-uuid-N"
		expect(file.uri).toMatch(/mock-uuid-\d+$/)
	})

	it("newTmpFile('custom.bin') returns a File at filen-tmp/custom.bin", async () => {
		const { newTmpFile, TMP_DIR_NAME } = await freshTmp()
		const file = newTmpFile("custom.bin")

		expect(file.uri).toContain(TMP_DIR_NAME)
		expect(file.uri).toMatch(/custom\.bin$/)
	})

	it("newTmpDir() with no argument returns a Directory inside filen-tmp with a UUID-shaped name", async () => {
		const { newTmpDir, TMP_DIR_NAME } = await freshTmp()
		const dir = newTmpDir()

		expect(dir.uri).toContain(TMP_DIR_NAME)
		expect(dir.uri).toMatch(/mock-uuid-\d+$/)
	})

	it("newTmpDir('export') returns a Directory at filen-tmp/export", async () => {
		const { newTmpDir, TMP_DIR_NAME } = await freshTmp()
		const dir = newTmpDir("export")

		expect(dir.uri).toContain(TMP_DIR_NAME)
		expect(dir.uri).toMatch(/export$/)
	})

	it("calling newTmpFile() when the directory does not exist triggers directory creation", async () => {
		const { newTmpFile, TMP_DIR_NAME } = await freshTmp()

		// FS is empty — ensure() must create the dir
		const file = newTmpFile("trigger.bin")

		expect(file.uri).toContain(TMP_DIR_NAME)

		const { Directory } = await import("expo-file-system")
		const parent = new Directory(file.uri.replace(/\/[^/]+$/, ""))

		expect(parent.exists).toBe(true)
	})

	it("after ensure() runs once with a live directory, a second newTmpFile() skips create (idempotency)", async () => {
		const { newTmpFile } = await freshTmp()
		const { Directory } = await import("expo-file-system")

		// Spy on Directory.prototype.create to count invocations
		const createSpy = vi.spyOn(Directory.prototype, "create")

		newTmpFile("first.bin")
		newTmpFile("second.bin")

		// create() should have been called at most once (ensured=true after first call)
		const createCount = createSpy.mock.calls.length

		expect(createCount).toBeLessThanOrEqual(1)

		createSpy.mockRestore()
	})

	it("if the directory is externally deleted after first ensure(), the next newTmpFile() recreates it", async () => {
		const { newTmpFile } = await freshTmp()

		// First call — triggers ensure, sets ensured=true
		const first = newTmpFile("first.bin")
		const tmpPath = first.uri.replace(/\/[^/]+$/, "")

		// External deletion of the tmp dir
		const { Directory } = await import("expo-file-system")
		const tmpDir = new Directory(tmpPath)

		tmpDir.delete()
		expect(tmpDir.exists).toBe(false)

		// Next call — ensured is true BUT directory.exists is false → must recreate
		const second = newTmpFile("second.bin")

		expect(second.uri).toContain(tmpPath)

		const tmpDirAfter = new Directory(tmpPath)

		expect(tmpDirAfter.exists).toBe(true)
	})
})
