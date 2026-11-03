import { generateKeyPairSync } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import { inflateSync } from "node:zlib"
import path from "node:path"
import type { DesktopSyncPair, DesktopSyncPhase } from "@filen/shared/desktop"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	fixtureTree,
	LEGACY_CONFLICTS,
	LEGACY_DELTAS,
	LEGACY_LOCAL_TRASH,
	legacyLocalTree,
	LEGACY_PAIRS,
	legacySideTree,
	seededBytes,
	treeSnapshot,
	writeTree
} from "../../scripts/ci/e2e/fixtures.ts"
import { parseAbout } from "../../scripts/ci/e2e/cloud.ts"
import { createFindings } from "../../scripts/ci/e2e/findings.ts"
import { appImagePrefixes, appImageTree, type ProcessEntry, xwdToPng } from "../../scripts/ci/e2e/linux.ts"
import { describeSample, sampleOf, windowsFirewallRules } from "../../scripts/ci/e2e/offlineBlock.ts"
import { openRemote, readSealed, remoteOf, sealRemote, secretsOf, SESSION_FILE_ENV, writeSealed } from "../../scripts/ci/e2e/session.ts"
import { diffSnapshots, localSnapshot } from "../../scripts/ci/e2e/snapshot.ts"
import { isChromiumChild } from "../../scripts/ci/targets.ts"

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
		expect(diffSnapshots(before, new Map(), { identity: false, allowed: ["docs", "media", "nested"] }).sort()).toEqual([
			"missing empty-dir",
			"missing space name.txt",
			"missing Ünïcødé ✓ name.txt".normalize("NFC")
		])
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

	it("hands the sealed session over as a file, never through the environment", () => {
		const file = path.join(tempDir(), "session", "session.sealed")
		const before = process.env[SESSION_FILE_ENV]

		process.env[SESSION_FILE_ENV] = file

		try {
			const sealed = sealRemote(remoteOf(client), "password", "123")

			expect(writeSealed(sealed)).toBe(file)
			expect(readSealed()).toBe(sealed)
			expect(Object.values(process.env)).not.toContain(sealed)
			process.env[SESSION_FILE_ENV] = path.join(tempDir(), "missing")
			expect(() => readSealed()).toThrow(/names no sealed session/)
		} finally {
			if (before === undefined) {
				delete process.env[SESSION_FILE_ENV]
			} else {
				process.env[SESSION_FILE_ENV] = before
			}
		}
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

describe("e2e main process detection", () => {
	it("tells a retitled Chromium child from the main process", () => {
		// The main process: its own NUL-separated arguments.
		expect(isChromiumChild("/opt/Filen/Filen\0--remote-debugging-port=40063\0")).toBe(false)
		// A child that kept its arguments.
		expect(isChromiumChild("/opt/Filen/Filen\0--type=zygote\0--no-zygote-sandbox\0")).toBe(true)
		// A child after setproctitle: one space-joined title, padded with NULs.
		expect(isChromiumChild("/opt/Filen/Filen --type=gpu-process --enable-crash-reporter\0\0\0")).toBe(true)
		expect(isChromiumChild("/opt/Filen/Filen --type=utility --utility-sub-type=node.mojom.NodeService\0")).toBe(true)
	})
})

describe("e2e AppImage processes", () => {
	const executable = "/home/runner/Applications/Filen_linux_x86_64.AppImage"
	const prefixes = appImagePrefixes("/tmp")

	it("looks for the extracted and the mounted app under $TMPDIR and /tmp", () => {
		expect(appImagePrefixes("/tmp")).toEqual(["/tmp/appimage_extracted_", "/tmp/.mount_"])
		expect(appImagePrefixes("/run/user/1001")).toEqual([
			"/run/user/1001/appimage_extracted_",
			"/run/user/1001/.mount_",
			"/tmp/appimage_extracted_",
			"/tmp/.mount_"
		])
	})

	it("takes the runtime, everything below it and whatever runs from its extracted copy", () => {
		const extracted = "/tmp/appimage_extracted_0f3a/Filen"
		const entries: ProcessEntry[] = [
			{ pid: 10, ppid: 1, exe: "/usr/bin/bash", argv0: "/usr/bin/bash" },
			// sudo -g starts the runtime; its exe is unreadable then.
			{ pid: 20, ppid: 10, exe: "/usr/bin/sudo", argv0: "/usr/bin/sudo" },
			{ pid: 21, ppid: 20, exe: null, argv0: executable },
			{ pid: 22, ppid: 21, exe: null, argv0: extracted },
			{ pid: 23, ppid: 22, exe: null, argv0: extracted },
			{ pid: 24, ppid: 22, exe: null, argv0: "/tmp/appimage_extracted_0f3a/resources/rclone/rclone" },
			// Reparented to init once its parent died: found by its prefix.
			{ pid: 30, ppid: 1, exe: "/tmp/appimage_extracted_0f3a/resources/rclone/rclone", argv0: "rclone" },
			// The deb's app and another AppImage are not this one.
			{ pid: 40, ppid: 1, exe: "/opt/Filen/Filen", argv0: "/opt/Filen/Filen" },
			{ pid: 41, ppid: 1, exe: "/home/runner/Other.AppImage", argv0: "/home/runner/Other.AppImage" }
		]

		expect(appImageTree(entries, executable, prefixes)).toEqual([
			`21 ${executable}`,
			`22 ${extracted}`,
			`23 ${extracted}`,
			"24 /tmp/appimage_extracted_0f3a/resources/rclone/rclone",
			"30 /tmp/appimage_extracted_0f3a/resources/rclone/rclone"
		])
	})

	it("knows the runtime after an update replaced its file, and the app exec'd from a FUSE mount", () => {
		const entries: ProcessEntry[] = [
			{ pid: 5, ppid: 1, exe: `${executable} (deleted)`, argv0: executable },
			{ pid: 6, ppid: 5, exe: "/usr/bin/fusermount3", argv0: "fusermount3" },
			{ pid: 7, ppid: 1, exe: "/tmp/.mount_FilenAb12/Filen", argv0: "/tmp/.mount_FilenAb12/Filen" },
			// Readable exe elsewhere with the AppImage as argv0: not the runtime.
			{ pid: 8, ppid: 1, exe: "/usr/bin/sleep", argv0: executable }
		]

		expect(appImageTree(entries, executable, prefixes)).toEqual([
			`5 ${executable} (deleted)`,
			"6 /usr/bin/fusermount3",
			"7 /tmp/.mount_FilenAb12/Filen"
		])
		expect(appImageTree([], executable, prefixes)).toEqual([])
	})
})

describe("e2e offline block", () => {
	it("blocks Filen.exe and the bundled rclone.exe on Windows", () => {
		expect(windowsFirewallRules("C:\\Program Files\\Filen\\Filen.exe")).toEqual([
			{ name: "filen-e2e-offline", program: "C:\\Program Files\\Filen\\Filen.exe" },
			{ name: "filen-e2e-offline-rclone", program: "C:\\Program Files\\Filen\\resources\\rclone\\rclone.exe" }
		])
	})

	it("counts pairs waiting for the cloud apart from offline and error ones", () => {
		const pair = (id: string, phase: DesktopSyncPhase, lastError: string | null = null): DesktopSyncPair => ({
			id,
			name: `pair-${id}`,
			localRoot: `/local/${id}`,
			remoteRoot: id,
			mode: "twoWay",
			paused: false,
			phase,
			progress: null,
			transfers: [],
			lastSyncedAt: null,
			lastError,
			issues: { conflicts: 0, heldDeletions: 0, unsyncable: 0, failed: 0 },
			degraded: { local: false, remote: false },
			stage: phase === "waitingForCloud" ? { kind: "waitingForCloud" } : null,
			halted: phase === "offline" ? "offline" : null,
			refused: null,
			review: null,
			notices: [],
			rootProblem: null,
			holds: [],
			info: []
		})
		const sample = sampleOf(
			[pair("a", "waitingForCloud"), pair("b", "waitingForCloud"), pair("c", "offline"), pair("d", "error", "boom")],
			"Computer, Sync, needs attention",
			1000
		)

		expect(sample).toEqual({
			at: 1000,
			phases: "pair-a:waitingForCloud, pair-b:waitingForCloud, pair-c:offline, pair-d:error(lastError)",
			offline: 1,
			waiting: 2,
			errors: 1,
			pairs: 4,
			lastErrors: 1,
			rail: "Computer, Sync, needs attention",
			syncAttention: true
		})
		expect(describeSample(sample)).toBe(
			'pair-a:waitingForCloud, pair-b:waitingForCloud, pair-c:offline, pair-d:error(lastError); 2 of 4 waiting for the cloud; rail "Computer, Sync, needs attention"'
		)
		expect(sampleOf([pair("a", "idle")], "Computer", 0)).toMatchObject({ waiting: 0, offline: 0, syncAttention: false })
	})
})

describe("e2e findings", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("records a known bug that still reproduces without failing the run", async () => {
		vi.stubEnv("GITHUB_STEP_SUMMARY", "")

		const artifacts = tempDir()
		const findings = createFindings("known", artifacts)

		expect(
			await findings.known("a pair survives a rename", "filen-rs#1", () => {
				throw new Error("the pair is gone")
			})
		).toBe(true)
		expect(() => findings.finish()).not.toThrow()
		expect(JSON.parse(readFileSync(path.join(artifacts, "known-findings.json"), "utf8"))).toEqual([
			{ check: "a pair survives a rename", ok: true, info: false, known: true, detail: "filen-rs#1: the pair is gone" }
		])
	})

	it("fails the run once a known bug no longer reproduces, the detail redacted", async () => {
		vi.stubEnv("GITHUB_STEP_SUMMARY", "")

		const artifacts = tempDir()
		const findings = createFindings("fixed", artifacts, text => text.replace("secret", "***"))

		expect(await findings.known("a pair survives a rename", "filen-rs#1", async () => "kept the secret pair")).toBe(false)
		expect(() => findings.finish()).toThrow(/1 check\(s\) failed: a pair survives a rename/)
		expect(JSON.parse(readFileSync(path.join(artifacts, "fixed-findings.json"), "utf8"))).toEqual([
			{
				check: "a pair survives a rename",
				ok: false,
				info: false,
				known: false,
				detail: "known bug no longer reproduces, drop the entry (filen-rs#1): kept the *** pair"
			}
		])
	})
})

describe("e2e cloud usage", () => {
	it("reads rclone about's figures and leaves out what the backend does not give", () => {
		expect(parseAbout('{"total":21495808,"used":1048576,"free":20447232}')).toEqual({
			total: 21495808,
			used: 1048576,
			free: 20447232,
			trashed: null
		})
		expect(parseAbout('{"used":5,"trashed":2,"other":"x"}')).toEqual({ total: null, used: 5, free: null, trashed: 2 })
		expect(() => parseAbout("not json")).toThrow()
	})
})

describe("chain L fixtures", () => {
	it("covers every old mode once, with both switches mixed", () => {
		expect(LEGACY_PAIRS.map(pair => pair.legacyMode).sort()).toEqual([
			"cloudBackup",
			"cloudToLocal",
			"localBackup",
			"localToCloud",
			"twoWay"
		])
		expect(new Set(LEGACY_PAIRS.map(pair => pair.excludeDotFiles)).size).toBe(2)
		expect(new Set(LEGACY_PAIRS.map(pair => pair.localTrashDisabled)).size).toBe(2)
	})

	it("keeps dot entries on the seeded side only when they are excluded", () => {
		const twoWay = LEGACY_PAIRS.find(pair => pair.name === "e2e-twoway")
		const l2c = LEGACY_PAIRS.find(pair => pair.name === "e2e-l2c")

		expect(twoWay && legacySideTree(twoWay, "local").files.has(".hidden.txt")).toBe(true)
		expect(twoWay && legacySideTree(twoWay, "cloud").files.has(".hidden.txt")).toBe(false)
		expect(l2c && legacySideTree(l2c, "cloud").files.has(".hidden.txt")).toBe(true)
	})

	it("expects 3.x's local trash directory, empty, in the pairs it filled by downloads, whatever their trash switch", () => {
		const withTrash = LEGACY_PAIRS.filter(pair => legacyLocalTree(pair).emptyDirs.includes(LEGACY_LOCAL_TRASH)).map(pair => pair.name)

		expect(withTrash).toEqual(["e2e-c2l", "e2e-cbak"])
		expect(LEGACY_PAIRS.filter(pair => withTrash.includes(pair.name)).map(pair => pair.localTrashDisabled)).toEqual([true, false])
	})

	it("allows a rule file where dot files were excluded (uploaded only by a pair that pushes), the cloud edit, the old trash moved to the bin, and one held conflict", () => {
		expect(LEGACY_DELTAS.map(delta => `${delta.side} ${delta.pair}/${delta.path} ${delta.change}`).sort()).toEqual([
			"cloud e2e-twoway/.filenignore rules",
			"local e2e-c2l/.filen.trash.local binned",
			"local e2e-c2l/.filenignore rules",
			"local e2e-c2l/media/blob.bin edit",
			"local e2e-cbak/.filen.trash.local binned",
			"local e2e-cbak/.filenignore rules",
			"local e2e-twoway/.filenignore rules"
		])
		expect(LEGACY_CONFLICTS).toEqual({ "e2e-twoway": ["docs/notes.txt"] })
	})
})
