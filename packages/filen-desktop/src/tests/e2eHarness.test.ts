import { generateKeyPairSync } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import { inflateSync } from "node:zlib"
import path from "node:path"
import type { DesktopSyncPair, DesktopSyncPhase } from "@filen/shared/desktop"
import type { Page } from "playwright-core"
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
import {
	DEAD_PEER_ISSUE,
	describeSample,
	LIVE_OFFLINE_MS,
	pfStateKills,
	type Sample,
	sampleOf,
	SDK_READ_TIMEOUT_MS,
	silentBlock,
	watchOffline,
	windowsFirewallRules
} from "../../scripts/ci/e2e/offlineBlock.ts"
import { describeStored, LEGACY_SDK_CONFIG_SHAPE, legacySeed, SESSION_SHAPE, sessionEnvelope } from "../../scripts/ci/e2e/seed.ts"
import {
	cacheKey,
	CACHE_DIR_ENV,
	canonicalClient,
	harnessSession,
	openRecord,
	readCached,
	readHandOff,
	remoteOf,
	runKey,
	sealRecord,
	secretsOf,
	SESSION_DIR_ENV,
	SESSION_KEY_ENV,
	writeCached,
	writeHandOff
} from "../../scripts/ci/e2e/session.ts"
import { LEGACY_KEYS, legacySession } from "../../src/main/legacyData.ts"
import { diffSnapshots, localSnapshot } from "../../scripts/ci/e2e/snapshot.ts"
import { isChromiumChild } from "../../scripts/ci/targets.ts"
import { chooserRetries, MAC_CHOOSER_TIMEOUT_MS, panelWaitS } from "../../scripts/ci/e2e/mac.ts"
import { CHOOSER_BUDGET_MS, type DesktopOs } from "../../scripts/ci/e2e/os.ts"
import { chooseThrough } from "../../scripts/ci/e2e/extraPair.ts"

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

	const secret = "an organization secret of at least 32 characters"
	const record = { client, mintedAt: 1_700_000_000_000 }

	// Runs `body` with the given environment, restoring every variable it names afterwards.
	const withEnv = (env: Record<string, string>, body: () => void): void => {
		const before = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]))

		Object.assign(process.env, env)

		try {
			body()
		} finally {
			for (const [name, value] of Object.entries(before)) {
				if (value === undefined) {
					delete process.env[name]
				} else {
					process.env[name] = value
				}
			}
		}
	}

	it("seals a record for its slot under a key from the secret, and for the run's hand-off under the run as salt", () => {
		const sealed = sealRecord(record, cacheKey(secret), "test")

		expect(sealed).not.toContain("api-key")
		expect(openRecord(sealed, cacheKey(secret), "test")).toEqual(record)
		expect(() => openRecord(sealed, cacheKey(secret), "quota")).toThrow()
		expect(() => openRecord(sealed, cacheKey(`${secret}!`), "test")).toThrow()
		expect(() => openRecord(sealed, runKey(secret, "123"), "test")).toThrow()
		expect(openRecord(sealRecord(record, runKey(secret, "123"), "test"), runKey(secret, "123"), "test")).toEqual(record)
		expect(() => openRecord(sealRecord(record, runKey(secret, "123"), "test"), runKey(secret, "124"), "test")).toThrow()
		expect(() => openRecord(`${sealed}.x`, cacheKey(secret), "test")).toThrow(/malformed/)
	})

	it("hands the sealed session over as a file, never through the environment", () => {
		const dir = path.join(tempDir(), "session")

		withEnv({ [SESSION_DIR_ENV]: dir, [SESSION_KEY_ENV]: secret, GITHUB_RUN_ID: "123" }, () => {
			expect(writeHandOff("test", record, secret)).toBe(path.join(dir, "test.sealed"))
			expect(Object.values(process.env).some(value => value?.includes(readHandOff("test")))).toBe(false)
			expect(harnessSession("test")).toEqual({ client, remote: remoteOf(client) })
			expect(process.env[SESSION_KEY_ENV]).toBeUndefined()
			expect(() => readHandOff("quota")).toThrow(/holds no sealed quota session/)
		})
	})

	it("takes a cached copy that does not open as a miss", () => {
		const dir = path.join(tempDir(), "cache")

		withEnv({ [CACHE_DIR_ENV]: dir }, () => {
			expect(readCached("test", secret)).toBeNull()
			writeCached("test", record, secret)
			expect(readCached("test", secret)).toEqual(record)
			expect(readCached("test", `${secret}!`)).toBeNull()
			writeFileSync(path.join(dir, "quota.sealed"), "not.sealed.text")
			expect(readCached("quota", secret)).toBeNull()
		})
	})

	it("keeps the stringified client's fields in sdk-rs's order and drops unset limits", () => {
		const { authVersion, apiKey, ...rest } = client
		const shuffled = { authVersion, apiKey, maxIoMemoryUsage: null, ...rest } as unknown as typeof client

		expect(Object.keys(canonicalClient(shuffled))).toEqual(Object.keys(client))
		expect(canonicalClient({ ...client, maxParallelRequests: 4 }).maxParallelRequests).toBe(4)
	})
})

describe("e2e sign-in seeds", () => {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
	const client = {
		email: "e2e@example.invalid",
		userId: 123n,
		rootUuid: "00000000-0000-0000-0000-000000000001",
		authInfo: "key-one|key-two",
		privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
		apiKey: "a".repeat(64),
		authVersion: 2
	}
	// What 3.0.53's signed-out start stores (filen-web 0.2.3 setup() for a fresh install): @filen/sdk 0.4.2's
	// ANONYMOUS_SDK_CONFIG with connectToSocket and metadataCache on, and DEFAULT_DESKTOP_CONFIG around a copy.
	const anonymousSdk = {
		email: "anonymous@filen.io",
		password: "anonymous",
		masterKeys: ["anonymous"],
		connectToSocket: true,
		metadataCache: true,
		twoFactorCode: "XXXXXX",
		publicKey: "anonymous",
		privateKey: "anonymous",
		apiKey: "anonymous",
		authVersion: 3,
		baseFolderUUID: "anonymous",
		userId: 1,
		tmpPath: "/tmp"
	}
	const anonymous = {
		sdkConfig: anonymousSdk,
		desktopConfig: {
			sdkConfig: anonymousSdk,
			webdavConfig: { enabled: false, username: "admin", password: "admin", hostname: "127.0.0.1", port: 1900 },
			s3Config: { enabled: false },
			networkDriveConfig: { enabled: false, mountPoint: "/tmp/filen" },
			syncConfig: { enabled: true, syncPairs: [], dbPath: "" }
		}
	}

	it("seeds 4.x with the envelope persistSession stores, in a real sign-in's shape", () => {
		const envelope = sessionEnvelope({ ...client, maxParallelRequests: undefined } as typeof client)

		expect(envelope).toBe(
			`{"email":"e2e@example.invalid","userId":"$bigint:123n","rootUuid":"${client.rootUuid}","authInfo":"key-one|key-two","privateKey":"${client.privateKey}","apiKey":"${client.apiKey}","authVersion":2}`
		)
		expect(describeStored(envelope, client.apiKey)).toEqual({ shape: [...SESSION_SHAPE], sameKey: true })
		expect(describeStored(envelope, "b".repeat(64)).sameKey).toBe(false)
	})

	it("seeds 3.0.53 with what its login stores, in a real sign-in's shape, which 4.x then migrates", () => {
		const seed = legacySeed(client, anonymous)
		const sdkConfig = JSON.parse(seed.sdkConfig) as Record<string, unknown>
		const desktopConfig = JSON.parse(seed.desktopConfig) as Record<string, unknown>

		expect(describeStored(seed.sdkConfig, client.apiKey)).toEqual({ shape: [...LEGACY_SDK_CONFIG_SHAPE], sameKey: true })
		expect(sdkConfig).toEqual({
			email: client.email,
			password: "redacted",
			masterKeys: ["key-one", "key-two"],
			connectToSocket: true,
			metadataCache: true,
			twoFactorCode: "redacted",
			publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
			privateKey: client.privateKey,
			apiKey: client.apiKey,
			authVersion: 2,
			baseFolderUUID: client.rootUuid,
			userId: 123,
			tmpPath: "/tmp"
		})
		// desktopConfig: the defaults as stored, the account in place of the anonymous config.
		expect(Object.keys(desktopConfig)).toEqual(Object.keys(anonymous.desktopConfig))
		expect(desktopConfig).toEqual({ ...anonymous.desktopConfig, sdkConfig })

		// 4.x imports it as the session a 4.x sign-in stores (its own key order).
		const migrated = legacySession({
			[LEGACY_KEYS.authed]: "true",
			[LEGACY_KEYS.sdkConfig]: seed.sdkConfig,
			[LEGACY_KEYS.desktopConfig]: seed.desktopConfig
		})

		expect(migrated.ok && JSON.parse(migrated.blob)).toEqual(JSON.parse(sessionEnvelope(client)))
	})

	it("describes a stored value by keys and types only", () => {
		const described = describeStored(JSON.stringify({ apiKey: "x", list: ["a", 1], none: null, nested: { a: 1 } }), "x")

		expect(described).toEqual({ shape: ["apiKey: string", "list: string|number[]", "none: null", "nested: object"], sameKey: true })
		expect(describeStored("[1]", "x")).toEqual({ shape: [], sameKey: false })
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

	it("kills pf states to each remote in its own address family", () => {
		expect(pfStateKills(["104.18.2.3", "2606:4700::6812:203"])).toEqual([
			["-k", "0.0.0.0/0", "-k", "104.18.2.3"],
			["-k", "::/0", "-k", "2606:4700::6812:203"]
		])
		expect(pfStateKills([])).toEqual([])
	})

	describe("watchOffline", () => {
		const offline = sampleOf([], "Computer", 0)
		const run = async (silent: boolean, results: { hit: Sample | null; last: Sample }[]) => {
			const caps: number[] = []
			const known = vi.fn(async (_name: string, _issue: string, probe: () => string | Promise<string>) => {
				await expect(Promise.resolve().then(probe)).rejects.toThrow(/reached after/)

				return true
			})
			const result = await watchOffline(
				{ known },
				"P11 a drop",
				{
					watch: capMs => {
						caps.push(capMs)

						return Promise.resolve(results[caps.length - 1] ?? { hit: null, last: offline })
					}
				},
				silent,
				() => true
			)

			return { result, caps, known }
		}

		it("is silent only where pf resets nothing", () => {
			expect(silentBlock("mac", "x64")).toBe(true)
			expect(silentBlock("mac", "arm64")).toBe(false)
			expect(silentBlock("linux", "x64")).toBe(false)
			expect(silentBlock("win", "x64")).toBe(false)
		})

		it("gives every platform 30 s, and a reset block no more", async () => {
			const prompt = await run(false, [{ hit: offline, last: offline }])

			expect(prompt.caps).toEqual([LIVE_OFFLINE_MS])
			expect(prompt.result.hit).toBe(offline)
			expect(prompt.known).not.toHaveBeenCalled()

			const missed = await run(false, [{ hit: null, last: offline }])

			expect(missed.caps).toEqual([LIVE_OFFLINE_MS])
			expect(missed.result).toMatchObject({ hit: null, capMs: LIVE_OFFLINE_MS })
		})

		it("records a silent block's late offline as the known SDK bug, up to its read timeout", async () => {
			const late = await run(true, [
				{ hit: null, last: offline },
				{ hit: offline, last: offline }
			])

			expect(late.caps).toHaveLength(2)
			expect(late.caps[0]).toBe(LIVE_OFFLINE_MS)
			expect(late.caps[1]).toBeLessThanOrEqual(SDK_READ_TIMEOUT_MS + LIVE_OFFLINE_MS)
			expect(late.caps[1]).toBeGreaterThan(SDK_READ_TIMEOUT_MS)
			expect(late.result).toMatchObject({ hit: offline, capMs: SDK_READ_TIMEOUT_MS + LIVE_OFFLINE_MS })
			expect(late.known).toHaveBeenCalledWith("P11 a drop within 30.0 s on mac x64", DEAD_PEER_ISSUE, expect.any(Function))
		})

		it("still fails a silent block that never goes offline within the SDK's bound", async () => {
			const never = await run(true, [])

			expect(never.result).toMatchObject({ hit: null, capMs: SDK_READ_TIMEOUT_MS + LIVE_OFFLINE_MS })
			expect(never.known).not.toHaveBeenCalled()
		})

		it("records nothing for a silent block offline within 30 s", async () => {
			const prompt = await run(true, [{ hit: offline, last: offline }])

			expect(prompt.caps).toEqual([LIVE_OFFLINE_MS])
			expect(prompt.known).not.toHaveBeenCalled()
		})
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

describe("the macOS folder chooser", () => {
	const noPanel = "787:833: execution error: no open panel on Filen's windows within 30 s (-2700)"

	it("waits once more for a panel that never came up or a script that hung, and for nothing else", () => {
		expect(chooserRetries(1, false, noPanel)).toBe(true)
		expect(chooserRetries(2, false, noPanel)).toBe(false)
		expect(chooserRetries(1, true, "timed out")).toBe(true)
		expect(chooserRetries(2, true, "timed out")).toBe(false)
		expect(chooserRetries(1, false, "execution error: the panel stayed open after the path and Open; cancelled")).toBe(false)
		expect(chooserRetries(1, false, "execution error: Not authorized to send Apple events to System Events. (-1743)")).toBe(false)
	})

	it("names the panel's real wait, and retries on it whatever its length", () => {
		expect(chooserRetries(1, false, "execution error: no open panel on Filen's windows within 150 s (-2700)")).toBe(true)
	})

	it("waits for the panel by wall clock, longest on Intel, where the first panel of a launch is slow", () => {
		expect(panelWaitS("x64")).toBe(150)
		expect(panelWaitS("arm64")).toBe(30)
		expect(MAC_CHOOSER_TIMEOUT_MS).toBe((panelWaitS(process.arch) + 60) * 1000)
	})

	it("gives the app's call the time of both waits", () => {
		expect(CHOOSER_BUDGET_MS).toBeGreaterThanOrEqual(4 * 60 * 1000)

		if (process.platform === "darwin") {
			expect(CHOOSER_BUDGET_MS).toBeGreaterThan(2 * MAC_CHOOSER_TIMEOUT_MS)
		}
	})
})

describe("the folder chooser raced against the app's call", () => {
	const ok = { status: "ok", id: "root-1", path: "/tmp/pair", name: "pair", warnings: [] }

	// A page whose chooseLocalDirectory answers with `answer` after `answerMs`, and an OS whose driver finishes after
	// `driverMs` (or fails with `driverError`); screen dumps recorded.
	function harness(answer: unknown, answerMs: number, driverMs: number, driverError?: string) {
		const dumps: string[] = []
		const page = {
			evaluate: () =>
				new Promise(resolve =>
					setTimeout(() => {
						resolve(JSON.stringify({ value: answer }))
					}, answerMs)
				)
		}
		const desktopOs = {
			chooseDirectory: () =>
				new Promise<void>((resolve, reject) =>
					setTimeout(() => {
						if (driverError === undefined) {
							resolve()
						} else {
							reject(new Error(driverError))
						}
					}, driverMs)
				),
			screenDump: (file: string) => {
				dumps.push(path.basename(file))

				return Promise.resolve()
			}
		}

		return {
			dumps,
			chain: { page: () => page as unknown as Page, os: desktopOs as unknown as DesktopOs }
		}
	}

	it("returns the chosen directory once the driver is done, even when the app answered first", async () => {
		const { chain } = harness(ok, 1, 20)

		await expect(chooseThrough(chain, "/tmp/pair", "/tmp/evidence")).resolves.toEqual(ok)
	})

	it("fails at once when the call answers without a directory while the driver still waits for its dialog", async () => {
		const { chain, dumps } = harness({ status: "canceled" }, 1, 2000)
		const started = Date.now()

		await expect(chooseThrough(chain, "/tmp/pair", "/tmp/evidence")).rejects.toThrow(
			'chooseLocalDirectory answered while the chooser still waited for its dialog: {"status":"canceled"}'
		)
		expect(Date.now() - started).toBeLessThan(1000)
		expect(dumps).toEqual(["evidence-answered-early.png"])
	})

	it("fails with the driver's error when the driver fails first", async () => {
		const { chain } = harness(ok, 1000, 1, "the open panel: no open panel on Filen's windows within 30 s")

		await expect(chooseThrough(chain, "/tmp/pair", "/tmp/evidence")).rejects.toThrow("no open panel")
	})

	it("fails on an answer other than ok that came after the driver", async () => {
		const refused = { status: "refused", path: "/tmp/pair", problem: "notADirectory" }
		const { chain } = harness(refused, 20, 1)

		await expect(chooseThrough(chain, "/tmp/pair", "/tmp/evidence")).rejects.toThrow(`chooseLocalDirectory: ${JSON.stringify(refused)}`)
	})
})
