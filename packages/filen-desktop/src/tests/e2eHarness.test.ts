import { generateKeyPairSync } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import { inflateSync } from "node:zlib"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { fixtureTree, seededBytes, treeSnapshot, writeTree } from "../../scripts/ci/e2e/fixtures.ts"
import { xwdToPng } from "../../scripts/ci/e2e/linux.ts"
import { openRemote, remoteOf, sealRemote, secretsOf } from "../../scripts/ci/e2e/session.ts"
import { diffSnapshots, localSnapshot } from "../../scripts/ci/e2e/snapshot.ts"

const dirs: string[] = []

function tempDir(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "filen-e2e-test-"))

	dirs.push(dir)

	return dir
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true })
	}
})

describe("e2e fixtures and snapshots", () => {
	it("writes a deterministic tree that its own snapshot describes", async () => {
		const root = tempDir()
		const tree = fixtureTree("seed", true)

		expect(seededBytes("seed", 100)).toEqual(seededBytes("seed", 100))
		expect(seededBytes("seed", 100)).not.toEqual(seededBytes("other", 100))
		writeTree(root, tree)

		const snapshot = await localSnapshot(root)

		expect(diffSnapshots(treeSnapshot(tree), snapshot, { identity: false })).toEqual([])
		expect(snapshot.get("empty-dir")?.kind).toBe("dir")
		expect(snapshot.get("docs/empty.txt")?.size).toBe(0)
		expect(snapshot.get("media/blob.bin")?.size).toBe(1.5 * 1024 * 1024)
		expect(snapshot.has(".dotdir/inside.txt")).toBe(true)
		expect(fixtureTree("seed", false).files.has(".hidden.txt")).toBe(false)
	})

	it("names every difference, identities only when asked, and skips allowed paths", async () => {
		const root = tempDir()

		writeTree(root, fixtureTree("seed", false))

		const before = await localSnapshot(root)

		// Same bytes, rewritten: only an identity check sees it.
		writeFileSync(path.join(root, "space name.txt"), Buffer.from(fixtureTree("seed", false).files.get("space name.txt") ?? ""))
		writeFileSync(path.join(root, "docs", "notes.txt"), "changed")
		writeFileSync(path.join(root, "extra.txt"), "x")
		rmSync(path.join(root, "empty-dir"), { recursive: true })

		const after = await localSnapshot(root)

		expect(diffSnapshots(before, after, { identity: false }).sort()).toEqual([
			`docs/notes.txt: content changed (${String(before.get("docs/notes.txt")?.size)} -> 7 bytes)`,
			"missing empty-dir",
			"unexpected extra.txt"
		])
		expect(diffSnapshots(before, after, { identity: true })).toContain("space name.txt: rewritten (identity changed)")
		expect(diffSnapshots(before, after, { identity: false, allowed: ["docs/notes.txt", "empty-dir", "extra.txt"] })).toEqual([])
	})

	it("skips what the caller leaves out", async () => {
		const root = tempDir()

		writeTree(root, {
			files: new Map([
				["bin/x", Buffer.from("x")],
				["a", Buffer.from("a")]
			]),
			emptyDirs: []
		})

		expect([...(await localSnapshot(root, { skip: relPath => relPath === "bin" })).keys()]).toEqual(["a"])
	})
})

describe("e2e harness session", () => {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
	const client = {
		email: "e2e@example.invalid",
		userId: 1n,
		rootUuid: "00000000-0000-0000-0000-000000000001",
		authInfo: "key-one|key-two",
		privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
		apiKey: "api-key",
		authVersion: 2
	}

	it("maps the stringified client as sdk-rs gives it to rclone", () => {
		const remote = remoteOf(client)

		expect(remote.masterKeys).toEqual(["key-one", "key-two"])
		expect(remote.publicKey).toBe(publicKey.export({ type: "pkcs1", format: "der" }).toString("base64"))
		expect(remote.rootUuid).toBe(client.rootUuid)
		expect(secretsOf(remote)).toEqual(["api-key", "key-one", "key-two", remote.privateKey, remote.publicKey])
	})

	it("seals the session for one run and password only", () => {
		const remote = remoteOf(client)
		const sealed = sealRemote(remote, "password", "123")

		expect(sealed).not.toContain("api-key")
		expect(openRemote(sealed, "password", "123")).toEqual(remote)
		expect(() => openRemote(sealed, "password", "124")).toThrow()
		expect(() => openRemote(sealed, "wrong", "123")).toThrow()
	})
})

describe("e2e screen dumps", () => {
	it("turns a 32-bit X window dump into an RGB PNG", () => {
		// A 2x1 LSBFirst dump: header fields as big-endian words, no colormap, pixels B, G, R, pad.
		const header = Buffer.alloc(100)
		const fields: Record<number, number> = { 0: 100, 4: 2, 5: 1, 7: 0, 11: 32, 12: 8, 19: 0 }

		for (const [index, value] of Object.entries(fields)) {
			header.writeUInt32BE(value, Number(index) * 4)
		}

		const png = xwdToPng(Buffer.concat([header, Buffer.from([3, 2, 1, 0, 30, 20, 10, 0])]))
		const idat = png.indexOf("IDAT")

		expect(png.subarray(1, 4).toString("latin1")).toBe("PNG")
		expect(png.readUInt32BE(16)).toBe(2)
		expect(png.readUInt32BE(20)).toBe(1)
		expect([...inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)))]).toEqual([0, 1, 2, 3, 10, 20, 30])
	})
})
