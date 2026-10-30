import { describe, expect, it } from "vitest"
import { stringifyEnvelope } from "@filen/shared/session"
import { fileProviderChannel, type SessionRead } from "../shared/channels.ts"
import type { FileProviderAddon, FileProviderDomain } from "../main/fileProvider/addon.ts"
import { domainIdentifier, fileProviderAuth, THUMBNAIL_MEM_BUDGET_BYTES } from "../main/fileProvider/authFile.ts"
import { registerFileProviderIpc } from "../main/fileProvider/ipc.ts"
import { createFileProviderService, type FileProviderDeps } from "../main/fileProvider/service.ts"
import { createFileProviderStore } from "../main/fileProvider/store.ts"
import type { IpcEvent, IpcMain } from "../main/pages.ts"
import { memoryFile } from "./fileFakes.ts"

function blob(userId: bigint, email = "user@example.com"): string {
	return stringifyEnvelope({
		email,
		userId,
		rootUuid: "root-uuid",
		authInfo: "key1|key2",
		privateKey: "private",
		apiKey: "api-key",
		authVersion: 2
	})
}

// Records every call; a method named in `fail` rejects like the addon does.
function fakeAddon() {
	const calls: string[] = []
	const domains = new Map<string, FileProviderDomain>()
	const fail = new Set<keyof FileProviderAddon>()
	const pushed: string[] = []

	function maybeFail(method: keyof FileProviderAddon): Promise<void> {
		if (fail.has(method)) {
			return Promise.reject(Object.assign(new Error("failed"), { domain: "FilenFileProvider", code: 3 }))
		}

		return Promise.resolve()
	}

	const addon: FileProviderAddon = {
		addDomain: async ({ identifier, displayName }) => {
			calls.push(`add ${identifier}`)
			await maybeFail("addDomain")
			domains.set(identifier, { identifier, displayName, userEnabled: true })
		},
		removeDomain: async ({ identifier }) => {
			calls.push(`remove ${identifier}`)
			await maybeFail("removeDomain")
			domains.delete(identifier)
		},
		listDomains: () => Promise.resolve([...domains.values()]),
		signalWorkingSet: () => Promise.resolve(),
		pushAuth: async ({ identifier, json }) => {
			calls.push(`push ${identifier}`)
			await maybeFail("pushAuth")
			pushed.push(json)
		},
		clearAuth: async ({ identifier }) => {
			calls.push(`clear ${identifier}`)
			await maybeFail("clearAuth")
		}
	}

	return { addon, calls, domains, fail, pushed }
}

function setup(options: { session?: SessionRead; supported?: boolean; pin?: boolean } = {}) {
	const fake = fakeAddon()
	const files = new Map<string, ReturnType<typeof memoryFile>>()
	const fileFor = (userId: string) => {
		let file = files.get(userId)

		if (file === undefined) {
			file = memoryFile()
			files.set(userId, file)
		}

		return file
	}
	const state = {
		session: options.session ?? ({ status: "present", blob: blob(7n) } as SessionRead),
		pin: options.pin ?? false,
		loads: 0
	}
	const clearOwed = memoryFile()
	const warnings: string[] = []
	const deps: FileProviderDeps = {
		supported: () => options.supported ?? true,
		addon: () => {
			state.loads++

			return fake.addon
		},
		vault: { get: () => Promise.resolve(state.session) },
		store: createFileProviderStore(fileFor, message => warnings.push(message)),
		clearOwed,
		pinSet: () => state.pin,
		log: { info: () => undefined, warn: message => warnings.push(message) }
	}

	return { ...fake, service: createFileProviderService(deps), state, files: fileFor, clearOwed, warnings }
}

describe("fileProviderAuth", () => {
	it("maps the session blob to the extension's AuthFile", () => {
		const auth = fileProviderAuth(blob(123n))

		expect(auth?.userId).toBe("123")
		expect(auth?.displayName).toBe("user@example.com")
		expect(JSON.parse(auth?.json ?? "")).toEqual({
			providerEnabled: true,
			sdkConfig: {
				email: "user@example.com",
				password: "redacted",
				twoFactorCode: "redacted",
				masterKeys: ["key1", "key2"],
				apiKey: "api-key",
				publicKey: "",
				privateKey: "private",
				authVersion: 2,
				baseFolderUUID: "root-uuid",
				userId: 123,
				metadataCache: false,
				tmpPath: "",
				connectToSocket: false
			},
			thumbnailMemBudget: THUMBNAIL_MEM_BUDGET_BYTES
		})
	})

	it("is null for anything but a session", () => {
		expect(fileProviderAuth("{}")).toBeNull()
		expect(fileProviderAuth("not json")).toBeNull()
	})
})

describe("file provider service", () => {
	const domain = domainIdentifier("7")

	it("adds the domain and pushes the session on enable, and persists the switch", async () => {
		const { service, calls, pushed, files } = setup()
		const state = await service.enable()

		expect(state).toEqual({ supported: true, enabled: true, lockBlocked: false, userEnabled: true })
		expect(calls).toEqual([`add ${domain}`, `push ${domain}`])
		expect(pushed).toHaveLength(1)
		expect(files("7").data?.toString()).toBe(JSON.stringify({ version: 1, enabled: true }))
	})

	it("refuses to enable while a PIN is set, where unsupported, and without a session", async () => {
		await expect(setup({ pin: true }).service.enable()).rejects.toThrow("app lock set")
		await expect(setup({ supported: false }).service.enable()).rejects.toThrow("unsupported")
		await expect(setup({ session: { status: "unreadable" } }).service.enable()).rejects.toThrow("no session")
	})

	it("clears the session before removing the domain on disable", async () => {
		const { service, calls, files } = setup()

		await service.enable()
		calls.length = 0

		const state = await service.disable()

		expect(calls).toEqual([`clear ${domain}`, `remove ${domain}`])
		expect(state.enabled).toBe(false)
		expect(files("7").data).toBeNull()
	})

	it("removes the domain when the clear fails, and clears on the next registration", async () => {
		const { service, calls, fail, clearOwed } = setup()

		await service.enable()
		fail.add("clearAuth")
		await service.signedOut("7")

		expect(calls.slice(-2)).toEqual([`clear ${domain}`, `remove ${domain}`])
		expect(clearOwed.data).not.toBeNull()

		fail.delete("clearAuth")
		calls.length = 0
		await service.enable()

		expect(calls).toEqual([`add ${domain}`, `clear ${domain}`, `push ${domain}`])
		expect(clearOwed.data).toBeNull()
	})

	it("never loads the addon for a user who has it off", async () => {
		const { service, state } = setup()

		await service.launch()
		await service.sessionChanged(blob(7n))
		await service.signedOut("7")
		await service.pinChanged()

		expect(state.loads).toBe(0)
	})

	it("registers again at launch and pushes every new session while on", async () => {
		const { service, calls } = setup()

		await service.enable()
		calls.length = 0
		await service.launch()
		await service.sessionChanged(blob(7n, "new@example.com"))

		expect(calls).toEqual([`add ${domain}`, `push ${domain}`, `add ${domain}`, `push ${domain}`])
	})

	it("does nothing at launch with an unreadable vault", async () => {
		const { service, calls, state } = setup()

		await service.enable()
		calls.length = 0
		state.session = { status: "unreadable" }
		await service.launch()

		expect(calls).toEqual([])
	})

	it("switches off at launch and on a PIN when a PIN is set", async () => {
		const { service, calls, state, files } = setup()

		await service.enable()
		calls.length = 0
		state.pin = true
		await service.pinChanged()

		expect(calls).toEqual([`clear ${domain}`, `remove ${domain}`])
		expect(files("7").data).toBeNull()

		const second = setup()

		await second.service.enable()
		second.calls.length = 0
		second.state.pin = true
		await second.service.launch()

		expect(second.calls).toEqual([`clear ${domain}`, `remove ${domain}`])
	})

	it("tears down the registered user's domain on a sign-out with no known user", async () => {
		const { service, calls, state } = setup()

		await service.enable()
		calls.length = 0
		state.session = { status: "absent" }
		await service.signedOut(null)

		expect(calls).toEqual([`clear ${domain}`, `remove ${domain}`])
	})

	it("switches the previous user off when another one's session arrives", async () => {
		const { service, calls, files } = setup()

		await service.enable()
		calls.length = 0
		await service.sessionChanged(blob(8n))

		expect(calls).toEqual([`clear ${domain}`, `remove ${domain}`])
		expect(files("7").data).toBeNull()
	})

	it("keeps the switch off when the domain removal fails, and reports the failure", async () => {
		const { service, fail, files } = setup()

		await service.enable()
		fail.add("removeDomain")

		await expect(service.disable()).rejects.toThrow("failed")
		expect(files("7").data).toBeNull()
	})

	it("reports what macOS says about the domain", async () => {
		const { service, domains } = setup()

		await service.enable()
		domains.set(domain, { identifier: domain, displayName: "user@example.com", userEnabled: false })

		await expect(service.state()).resolves.toEqual({ supported: true, enabled: true, lockBlocked: false, userEnabled: false })
		await expect(setup({ supported: false }).service.state()).resolves.toEqual({
			supported: false,
			enabled: false,
			lockBlocked: false,
			userEnabled: null
		})
	})
})

describe("file provider ipc", () => {
	function ipc() {
		const handlers = new Map<string, (event: IpcEvent, ...args: unknown[]) => unknown>()
		const main: IpcMain = {
			handle: (channel, listener) => {
				handlers.set(channel, listener)
			},
			on: () => undefined
		}

		return { main, handlers }
	}

	function event(url: string): IpcEvent {
		return { senderFrame: { url }, sender: { id: 1, send: () => undefined, isDestroyed: () => false } }
	}

	it("answers the app's own page only, with no arguments", async () => {
		const { main, handlers } = ipc()
		const { service } = setup()

		registerFileProviderIpc(main, service, url => url === "filen://app/")

		const state = handlers.get(fileProviderChannel("state"))

		expect(state).toBeDefined()
		await expect(Promise.resolve(state?.(event("filen://app/")))).resolves.toMatchObject({ supported: true })
		expect(() => state?.(event("https://example.com/"))).toThrow("untrusted sender")
		expect(() => state?.(event("filen://app/"), "extra")).toThrow("invalid file provider payload")
	})
})
