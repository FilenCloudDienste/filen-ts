import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopFuseStatus, DesktopMountsErrorCode, DesktopSyncHostState } from "@filen/shared/desktop"
import { CHANNELS, mountsChannel, type MountsCall } from "../shared/channels.ts"
import type { MountsOp, NativeMountsStatus, NativeOpArgs } from "../shared/nativeProtocol.ts"
import { createCredentialStore } from "../main/mounts/credentials.ts"
import { registerMountsIpc } from "../main/mounts/ipc.ts"
import { createMountsService, type MountsServiceDeps } from "../main/mounts/service.ts"
import { loadMountsStore, type MountsConfig, DEFAULT_MOUNTS } from "../main/mounts/store.ts"
import type { IpcEvent, IpcMain } from "../main/pages.ts"
import { createRootTokens, ROOT_TOKEN_TTL_MS } from "../main/sync/localRoot.ts"
import { fakeCipher, memoryFile } from "./fileFakes.ts"

const APP = "filen://app/"
const LAN = "192.168.1.5"

// An answer that fails the call with `code`.
class Refusal {
	readonly code: DesktopMountsErrorCode
	readonly message: string | undefined

	constructor(code: DesktopMountsErrorCode, message?: string) {
		this.code = code
		this.message = message
	}
}

type Answers = { [K in MountsOp]?: ((args: NativeOpArgs<K>) => unknown) | undefined }

const DRIVE_RUNNING: NativeMountsStatus = { roles: [{ role: "drive", state: "running", error: null }], uploads: { pending: 0, errored: 0 } }

let directory: string

beforeEach(async () => {
	directory = await realpath(await mkdtemp(path.join(tmpdir(), "filen-mounts-ipc-")))
})

afterEach(async () => {
	vi.useRealTimers()
	await rm(directory, { recursive: true, force: true })
})

async function setup(
	options: {
		platform?: NodeJS.Platform
		answers?: Answers
		senderUrl?: string
		config?: MountsConfig
		binary?: boolean
		confirm?: boolean
		install?: MountsServiceDeps["fuse"]["install"]
		legacy?: MountsServiceDeps["legacy"]
	} = {}
) {
	let clock = 1_000
	const host: DesktopSyncHostState = { state: "running" }
	const store = await loadMountsStore(
		memoryFile(options.config === undefined ? null : Buffer.from(JSON.stringify(options.config))),
		vi.fn()
	)
	const answers: Answers = {
		mountsApply: ({ desired }) =>
			desired.drive === null && desired.serves.length === 0 ? { roles: [], uploads: null } : DRIVE_RUNNING,
		mountsStatus: () => DRIVE_RUNNING,
		mountsStats: () => ({ transfers: [], uploadsInProgress: 0, uploadsQueued: 0 }),
		cacheUsage: () => ({ usedBytes: 10, freeBytes: 20 }),
		clearCache: () => null,
		driveLetters: () => ["X", "Y"],
		...options.answers
	}
	const callMounts = vi.fn((op: MountsOp, args: unknown) => {
		const answer = answers[op] as ((args: unknown) => unknown) | undefined
		const value = answer === undefined ? new Refusal("unknown") : answer(args)

		return Promise.resolve(
			value instanceof Refusal
				? { ok: false, error: value.message === undefined ? { code: value.code } : { code: value.code, message: value.message } }
				: { ok: true, value }
		)
	})
	const supervisor = {
		callMounts: callMounts as unknown as MountsServiceDeps["supervisor"]["callMounts"],
		subscribe: vi.fn(),
		ensure: vi.fn(),
		retry: vi.fn(),
		user: () => Promise.resolve({ userId: "1", rootUuid: "3f2b8c1e-6a4d-4e2f-9b7a-1c5d8e9f0a2b" }),
		state: () => host
	}
	const tokens = createRootTokens(() => clock)
	const credentials = createCredentialStore(memoryFile(), () => Promise.resolve(fakeCipher()), vi.fn())
	const clipboard = { writeText: vi.fn() }
	const confirmSignOut = vi.fn(() => Promise.resolve(options.confirm ?? true))
	const mountsDir = path.join(directory, "mounts", "1")
	const fuse: { status: DesktopFuseStatus } = { status: { state: "missing", installable: options.install !== undefined } }
	const service = createMountsService({
		supervisor,
		platform: options.platform ?? "linux",
		storeFor: () => Promise.resolve(store),
		credentialsFor: () => credentials,
		mountsDir: () => mountsDir,
		logFile: null,
		binary: options.binary === false ? null : { path: "/opt/filen/rclone", sha256: null },
		fuse: {
			status: () => Promise.resolve(fuse.status),
			gap: () => "fuse3",
			install: options.install ?? null
		},
		certificate: (_dir, protocol) =>
			Promise.resolve({ cert: `/tls/${protocol}.crt`, key: `/tls/${protocol}.key`, fingerprint: "AA:BB" }),
		interfaces: () => ({
			en0: [{ address: LAN, netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: `${LAN}/24` }]
		}),
		tokens,
		dialogs: {
			showOpenDialog: () => Promise.reject(new Error("unused")),
			mountPointContext: () =>
				Promise.resolve({ platform: options.platform ?? "linux", home: directory, appData: [], temporary: [], pairRoots: [] }),
			confirmSignOut
		},
		shell: { openPath: vi.fn(() => Promise.resolve("")) },
		clipboard,
		legacy: options.legacy ?? { prepare: () => Promise.resolve(), drain: () => Promise.resolve() },
		statusChanged: vi.fn(),
		now: () => clock,
		log: { info: vi.fn(), warn: vi.fn() }
	})
	const handlers = new Map<string, (event: IpcEvent, ...args: unknown[]) => unknown>()
	const listeners = new Map<string, (event: IpcEvent, ...args: unknown[]) => void>()
	const ipc: IpcMain = {
		handle: (channel, listener) => {
			handlers.set(channel, listener)
		},
		on: (channel, listener) => {
			listeners.set(channel, listener)
		}
	}
	const sent: [string, unknown][] = []
	const event: IpcEvent = {
		senderFrame: { url: options.senderUrl ?? APP },
		sender: {
			id: 3,
			send: (channel, payload) => {
				sent.push([channel, payload])
			},
			isDestroyed: () => false
		}
	}

	registerMountsIpc(ipc, service, url => url?.startsWith(APP) === true)
	service.nativeEvent({ t: "ready", pairs: [], reset: false }, "1")

	const ops = () => callMounts.mock.calls.map(([op]) => op)

	return {
		service,
		store,
		tokens,
		callMounts,
		supervisor,
		clipboard,
		confirmSignOut,
		credentials,
		fuse,
		sent,
		mountsDir,
		ops,
		argsOf: (op: MountsOp) => callMounts.mock.calls.filter(([name]) => name === op).map(([, args]) => args),
		advance: (ms: number) => {
			clock += ms
		},
		invoke: async (name: MountsCall, ...args: unknown[]) => {
			const handler = handlers.get(mountsChannel(name))

			if (handler === undefined) {
				throw new Error(`no handler for ${name}`)
			}

			return handler(event, ...args)
		},
		subscribe: (subscription: unknown) => listeners.get(CHANNELS.mountsSubscribe)?.(event, subscription),
		// Lets the apply a change queued run.
		settled: () => new Promise(resolve => setImmediate(resolve))
	}
}

async function mountPoint(): Promise<string> {
	const dir = path.join(directory, "Filen")

	await mkdir(dir, { recursive: true })

	return dir
}

async function withDriveMounted(context: Awaited<ReturnType<typeof setup>>): Promise<void> {
	expect(await context.invoke("setDrive", { enabled: true, mountPointId: context.tokens.issue(await mountPoint()) })).toEqual({
		ok: true,
		value: null
	})
	await vi.waitFor(() => {
		expect(context.ops()).toContain("mountsApply")
	})
}

describe("registerMountsIpc", () => {
	it("rejects unknown/expired/reused mount point ids", async () => {
		const { invoke, tokens, advance, store } = await setup()
		const dir = await mountPoint()

		expect(await invoke("setDrive", { mountPointId: "0".repeat(32) })).toEqual({ ok: false, error: { code: "mountPointExpired" } })

		const expired = tokens.issue(dir)

		advance(ROOT_TOKEN_TTL_MS)
		expect(await invoke("setDrive", { mountPointId: expired })).toEqual({ ok: false, error: { code: "mountPointExpired" } })

		const id = tokens.issue(dir)

		expect(await invoke("setDrive", { mountPointId: id })).toEqual({ ok: true, value: null })
		expect(await invoke("setDrive", { mountPointId: id })).toEqual({ ok: false, error: { code: "mountPointExpired" } })
		expect(store.get().drive.mountPoint).toBe(dir)
	})

	it("never takes a path from the page", async () => {
		const { invoke, ops } = await setup()
		const dir = await mountPoint()

		await expect(invoke("setDrive", { mountPointId: dir })).rejects.toThrow("invalid mounts payload")
		await expect(invoke("setDrive", { enabled: true, mountPoint: dir })).rejects.toThrow("invalid mounts payload")
		await expect(invoke("setServe", "webdav", { address: "" })).rejects.toThrow("invalid mounts payload")
		await expect(invoke("setServe", "webdav", { port: 0 })).rejects.toThrow("invalid mounts payload")
		await expect(invoke("overview", dir)).rejects.toThrow("invalid mounts payload")
		expect(ops()).toEqual([])
	})

	it("re-checks the mount point when it is set", async () => {
		const { invoke, tokens } = await setup()
		const dir = await mountPoint()

		await mkdir(path.join(dir, "inside"))
		expect(await invoke("setDrive", { mountPointId: tokens.issue(dir) })).toEqual({
			ok: false,
			error: { code: "mountPointInvalid", message: "notEmpty" }
		})
	})

	it("drive letter outside D-Z rejected", async () => {
		const { invoke, store } = await setup({ platform: "win32" })

		await expect(invoke("setDrive", { driveLetter: "C" })).rejects.toThrow("invalid mounts payload")
		await expect(invoke("setDrive", { driveLetter: "x" })).rejects.toThrow("invalid mounts payload")
		expect(await invoke("setDrive", { driveLetter: "Z" })).toEqual({ ok: false, error: { code: "driveLetterInUse" } })
		expect(await invoke("setDrive", { enabled: true })).toEqual({ ok: true, value: null })
		expect(store.get().drive).toMatchObject({ enabled: true, driveLetter: "X" })
	})

	it("untrusted sender rejected", async () => {
		const { invoke, subscribe, supervisor, ops } = await setup({ senderUrl: "https://example.com/" })

		await expect(invoke("overview")).rejects.toThrow("untrusted sender")
		await expect(invoke("setDrive", { enabled: true })).rejects.toThrow("untrusted sender")
		subscribe({ overview: true, stats: true })
		expect(supervisor.subscribe).not.toHaveBeenCalled()
		expect(ops()).toEqual([])
	})

	it("credentials returned only to the trusted frame", async () => {
		const trusted = await setup()
		const credentials = await trusted.invoke("credentials", "webdav")

		expect(credentials).toMatchObject({ ok: true, value: { kind: "basic" } })
		expect(await trusted.invoke("credentials", "webdav")).toEqual(credentials)
		await expect(trusted.invoke("credentials", "nfs")).rejects.toThrow("invalid mounts payload")

		expect(await trusted.invoke("copyCredential", "s3", "secret")).toEqual({ ok: true, value: null })
		const s3 = await trusted.credentials.get("s3")

		expect(trusted.clipboard.writeText).toHaveBeenCalledWith(s3?.kind === "s3" ? s3.secretAccessKey : null)

		const untrusted = await setup({ senderUrl: "filen://evil/" })

		await expect(untrusted.invoke("credentials", "webdav")).rejects.toThrow("untrusted sender")
		await expect(untrusted.invoke("copyCredential", "webdav", "secret")).rejects.toThrow("untrusted sender")
		expect(untrusted.clipboard.writeText).not.toHaveBeenCalled()
	})

	it("custom credentials pass the strength check", async () => {
		const { invoke, credentials } = await setup()

		expect(await invoke("setCredentials", "webdav", { kind: "basic", user: "bob", password: "short-pw" })).toEqual({
			ok: false,
			error: { code: "credentialsWeak" }
		})
		expect(
			await invoke("setCredentials", "webdav", { kind: "s3", accessKeyId: "AKIA0123456789ABCDEF", secretAccessKey: "a".repeat(40) })
		).toEqual({ ok: false, error: { code: "credentialsInvalid" } })
		await expect(invoke("setCredentials", "webdav", { kind: "basic", user: "bob", password: "with:colon-in-it" })).rejects.toThrow(
			"invalid mounts payload"
		)

		const strong = { kind: "basic", user: "bob", password: "correct horse battery staple" } as const

		expect(await invoke("setCredentials", "webdav", strong)).toEqual({ ok: true, value: null })
		expect(await credentials.get("webdav")).toEqual(strong)
		expect(await invoke("regenerateCredentials", "webdav")).toEqual({ ok: true, value: null })
		expect(await credentials.get("webdav")).not.toEqual(strong)
	})

	it("unauthenticated protocol needs acknowledgement", async () => {
		const { invoke, store } = await setup()

		expect(await invoke("setServe", "nfs", { enabled: true })).toEqual({ ok: false, error: { code: "acknowledgementRequired" } })
		expect(await invoke("setServe", "nfs", { address: LAN })).toEqual({ ok: false, error: { code: "addressUnavailable" } })
		expect(store.get().serves.nfs).toBeUndefined()
		expect(await invoke("setServe", "nfs", { enabled: true, acknowledgeUnauthenticated: true })).toEqual({ ok: true, value: null })
		expect(store.get().serves.nfs).toMatchObject({ enabled: true, host: "127.0.0.1", acknowledgedUnauthenticated: true })
	})

	it("nfs not offered on win32", async () => {
		const { invoke, store } = await setup({ platform: "win32" })

		expect(await invoke("setServe", "nfs", { enabled: true, acknowledgeUnauthenticated: true })).toEqual({
			ok: false,
			error: { code: "unsupportedProtocol" }
		})
		expect(store.get().serves.nfs).toBeUndefined()
		expect(((await invoke("overview")) as { protocols: string[] }).protocols).not.toContain("nfs")
	})

	it("LAN pre-ticks https", async () => {
		const { invoke, store } = await setup()

		expect(await invoke("setServe", "webdav", { address: LAN })).toEqual({ ok: true, value: null })
		expect(store.get().serves.webdav).toMatchObject({ host: LAN, https: true })
		expect(await invoke("setServe", "s3", { address: LAN, https: false })).toEqual({ ok: true, value: null })
		expect(store.get().serves.s3).toMatchObject({ host: LAN, https: false })
		expect(await invoke("setServe", "ftp", { address: LAN })).toEqual({ ok: true, value: null })
		expect(store.get().serves.ftp).toMatchObject({ host: LAN, https: false })
		expect(await invoke("setServe", "ftp", { https: true })).toEqual({ ok: false, error: { code: "unsupportedProtocol" } })
		expect(await invoke("setServe", "http", { address: "10.9.9.9" })).toEqual({ ok: false, error: { code: "addressUnavailable" } })
	})

	it("refuses a port another server listens on", async () => {
		const { invoke } = await setup()

		expect(await invoke("setServe", "webdav", { enabled: true, port: 8080 })).toEqual({ ok: true, value: null })
		expect(await invoke("setServe", "http", { enabled: true, port: 8080 })).toEqual({ ok: false, error: { code: "portInUse" } })
		expect(await invoke("setServe", "http", { enabled: true, port: 8081 })).toEqual({ ok: true, value: null })
	})

	it("an enabled server gets its credentials and certificate before the host is told", async () => {
		const { invoke, argsOf, credentials, service } = await setup()

		expect(await invoke("setServe", "webdav", { enabled: true, address: LAN })).toEqual({ ok: true, value: null })
		await vi.waitFor(() => {
			expect(argsOf("mountsApply")).toHaveLength(1)
		})

		const [apply] = argsOf("mountsApply") as NativeOpArgs<"mountsApply">[]

		expect(apply?.desired.serves).toEqual([
			{
				protocol: "webdav",
				host: LAN,
				port: 1900,
				auth: await credentials.get("webdav"),
				tls: { cert: "/tls/webdav.crt", key: "/tls/webdav.key" },
				readOnly: false
			}
		])
		const { serves } = await service.overview()

		expect(serves.find(serve => serve.protocol === "webdav")).toMatchObject({
			url: `https://${LAN}:1900`,
			addressKind: "lan",
			httpsCapable: true,
			tlsFingerprint: "AA:BB",
			authenticated: true
		})
		expect(serves.find(serve => serve.protocol === "ftp")).toMatchObject({ addressKind: "loopback", httpsCapable: false, https: false })
	})

	it("clearCache refuses with pending uploads", async () => {
		const pending = { value: 2 }
		const context = await setup({
			answers: { mountsStatus: () => ({ ...DRIVE_RUNNING, uploads: { pending: pending.value, errored: 0 } }) }
		})

		await withDriveMounted(context)
		expect(await context.invoke("clearCache")).toEqual({ ok: false, error: { code: "uploadsPending" } })
		expect(context.ops()).not.toContain("clearCache")

		pending.value = 0
		context.callMounts.mockClear()
		expect(await context.invoke("clearCache")).toEqual({ ok: true, value: null })
		expect(context.ops().slice(0, 4)).toEqual(["mountsStatus", "mountsApply", "clearCache", "mountsApply"])

		const [stop, restore] = context.argsOf("mountsApply") as NativeOpArgs<"mountsApply">[]

		expect(stop?.desired).toMatchObject({ drive: null, serves: [] })
		expect(restore?.desired.drive).not.toBeNull()
		expect(context.argsOf("clearCache")).toEqual([
			{ stateDir: path.join(context.mountsDir, "state"), dir: path.join(context.mountsDir, "cache") }
		])
	})

	it("mounts the host cannot run are an error, not a retry loop", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] })

		const context = await setup({ answers: { mountsApply: () => new Refusal("unknown", "mounts are not available") } })

		await withDriveMounted(context)
		await vi.advanceTimersByTimeAsync(60_000)
		expect(context.ops().filter(op => op === "mountsApply")).toHaveLength(1)
		expect((await context.service.overview()).drive).toMatchObject({
			enabled: true,
			state: "error",
			error: { code: "unknown", message: "mounts are not available" }
		})
	})

	it("without rclone nothing is sent and the overview says so", async () => {
		const context = await setup({ binary: false })

		expect(await context.invoke("setDrive", { enabled: true, mountPointId: context.tokens.issue(await mountPoint()) })).toEqual({
			ok: true,
			value: null
		})
		await context.settled()
		expect(context.ops()).toEqual([])
		expect(await context.service.overview()).toMatchObject({
			available: false,
			drive: { enabled: true, state: "error", error: { code: "binaryInvalid" } }
		})
	})

	it("stats stream only while a page listens and a role runs", async () => {
		const context = await setup()

		context.subscribe({ overview: false, stats: true })
		expect(context.supervisor.subscribe).toHaveBeenLastCalledWith(false, "mounts")
		expect(await context.invoke("stats")).toEqual({ transfers: [], uploadsInProgress: 0, uploadsQueued: 0 })
		expect(context.ops()).toEqual([])

		await withDriveMounted(context)
		await vi.waitFor(() => {
			expect(context.supervisor.subscribe).toHaveBeenLastCalledWith(true, "mounts")
		})

		context.service.nativeEvent({ t: "mountsStats", stats: { transfers: [], uploadsInProgress: 1, uploadsQueued: 0 } }, "1")
		expect(context.sent.filter(([channel]) => channel === CHANNELS.mountsStats)).toHaveLength(1)

		context.service.pageGone(3)
		expect(context.supervisor.subscribe).toHaveBeenLastCalledWith(false, "mounts")
	})

	it("FUSE is looked up for a page and again after an install, which mounts the drive again", async () => {
		const install = vi.fn(() => Promise.resolve("installed" as const))
		const context = await setup({ install })

		expect(await context.invoke("installFuse")).toEqual({ ok: true, value: "installed" })
		expect(install).toHaveBeenCalledTimes(1)

		context.subscribe({ overview: true, stats: false })
		await vi.waitFor(async () => {
			expect(await context.service.overview()).toMatchObject({ fuse: { state: "missing", installable: true }, fuseGap: "fuse3" })
		})

		await withDriveMounted(context)
		context.fuse.status = { state: "ready", provider: "winFsp" }
		context.callMounts.mockClear()
		expect(await context.invoke("installFuse")).toEqual({ ok: true, value: "installed" })
		expect(context.ops()).toEqual(["mountsApply"])
		expect(await context.service.overview()).toMatchObject({ fuse: { state: "ready", provider: "winFsp" }, fuseGap: null })

		const without = await setup()

		expect(await without.invoke("installFuse")).toEqual({ ok: false, error: { code: "fuseMissing" } })
	})

	it("dismissing a notice removes it", async () => {
		const { invoke, store } = await setup({ config: { ...DEFAULT_MOUNTS, notices: ["credentialsRegenerated", "lanBindDisabled"] } })

		await invoke("dismissNotice", "lanBindDisabled")
		expect(store.get().notices).toEqual(["credentialsRegenerated"])
		await expect(invoke("dismissNotice", "dlna")).rejects.toThrow("invalid mounts payload")
	})
})

describe("signing out", () => {
	it("asks only with pending uploads", async () => {
		const pending = { value: 0 }
		const context = await setup({
			confirm: false,
			answers: { mountsStatus: () => ({ ...DRIVE_RUNNING, uploads: { pending: pending.value, errored: 0 } }) }
		})

		expect(await context.invoke("confirmSignOut")).toBe(true)
		await withDriveMounted(context)
		expect(await context.invoke("confirmSignOut")).toBe(true)
		expect(context.confirmSignOut).not.toHaveBeenCalled()

		pending.value = 3
		expect(await context.invoke("confirmSignOut")).toBe(false)
		expect(context.confirmSignOut).toHaveBeenCalledWith(3)
	})

	it("logout keeps a cache with pending uploads", async () => {
		const context = await setup({ answers: { mountsStatus: () => ({ ...DRIVE_RUNNING, uploads: { pending: 1, errored: 0 } }) } })

		await withDriveMounted(context)
		await context.service.signOut("1")

		expect(context.ops()).not.toContain("clearCache")
		expect((context.argsOf("mountsApply") as NativeOpArgs<"mountsApply">[]).at(-1)?.desired).toMatchObject({ drive: null, serves: [] })
	})

	it("an errored upload keeps the cache too", async () => {
		const context = await setup({ answers: { mountsStatus: () => ({ ...DRIVE_RUNNING, uploads: { pending: 0, errored: 1 } }) } })

		await withDriveMounted(context)
		await context.service.signOut("1")
		expect(context.ops()).not.toContain("clearCache")
	})

	it("clean logout deletes the cache", async () => {
		const context = await setup()

		await withDriveMounted(context)
		await context.service.signOut("1")

		const ops = context.ops()

		expect(ops.slice(-3)).toEqual(["mountsStatus", "mountsApply", "clearCache"])
		expect(context.argsOf("clearCache")).toEqual([
			{ stateDir: path.join(context.mountsDir, "state"), dir: path.join(context.mountsDir, "cache") }
		])
	})

	it("roles start only after quiesce", async () => {
		const order: string[] = []
		let release = () => undefined as void
		const context = await setup({
			config: {
				...DEFAULT_MOUNTS,
				drive: { enabled: true, mountPoint: path.join(directory, "Filen"), driveLetter: null, readOnly: false }
			},
			answers: {
				mountsApply: () => {
					order.push("mountsApply")

					return DRIVE_RUNNING
				}
			},
			legacy: {
				prepare: () =>
					new Promise(resolve => {
						order.push("prepare")
						release = () => {
							order.push("prepared")
							resolve()
						}
					}),
				drain: () => {
					order.push("drain")

					return Promise.resolve()
				}
			}
		})

		await context.settled()
		expect(order).toEqual(["prepare"])
		release()
		await vi.waitFor(() => {
			expect(order).toEqual(["prepare", "prepared", "mountsApply", "drain"])
		})
	})

	it("a user without a cache has nothing to delete", async () => {
		const context = await setup()

		await context.service.signOut("1")
		expect(context.ops()).toEqual([])
	})
})
