import { describe, expect, it } from "vitest"
import { stringifyEnvelope } from "@filen/shared/session"
import { fileProviderChannel, type SessionRead } from "../shared/channels.ts"
import type { FileProviderAddon, FileProviderDomain } from "../main/fileProvider/addon.ts"
import { domainIdentifier, fileProviderAuth, THUMBNAIL_MEM_BUDGET_BYTES } from "../main/fileProvider/authFile.ts"
import { registerFileProviderIpc } from "../main/fileProvider/ipc.ts"
import {
	createFileProviderService,
	fileProviderDirectory,
	fileProviderErrorCode,
	type FileProviderDeps,
	runsTranslocated
} from "../main/fileProvider/service.ts"
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
	// What addDomain rejects with when it fails; the addon's "no auth service" by default.
	const failure = { domain: "FilenFileProvider", code: 3 }
	// What macOS reports for a newly added domain's switch.
	const added = { userEnabled: true }

	function maybeFail(method: keyof FileProviderAddon): Promise<void> {
		if (fail.has(method)) {
			return Promise.reject(Object.assign(new Error("failed"), failure))
		}

		return Promise.resolve()
	}

	const addon: FileProviderAddon = {
		addDomain: async ({ identifier, displayName }) => {
			calls.push(`add ${identifier}`)
			await maybeFail("addDomain")
			domains.set(identifier, { identifier, displayName, userEnabled: added.userEnabled })
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

	return { addon, calls, domains, fail, failure, added, pushed }
}

function setup(options: { session?: SessionRead; supported?: boolean; pin?: boolean; translocated?: boolean } = {}) {
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
		loads: 0,
		cloudStorage: ["Filen-user@example.com", "iCloud Drive"],
		openFailure: "",
		opened: [] as string[],
		settingsOpened: 0
	}
	const clearOwed = memoryFile()
	const warnings: string[] = []
	const infos: string[] = []
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
		translocated: () => options.translocated ?? false,
		cloudStorage: { root: "/Users/a/Library/CloudStorage", list: () => Promise.resolve(state.cloudStorage) },
		openPath: target => {
			state.opened.push(target)

			return Promise.resolve(state.openFailure)
		},
		openSettings: () => {
			state.settingsOpened++

			return Promise.resolve()
		},
		log: { info: message => infos.push(message), warn: message => warnings.push(message) }
	}

	return { ...fake, service: createFileProviderService(deps), state, files: fileFor, clearOwed, warnings, infos }
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

		await expect(service.enable()).resolves.toEqual({
			ok: true,
			value: { supported: true, enabled: true, lockBlocked: false, userEnabled: true, translocated: false }
		})
		expect(calls).toEqual([`add ${domain}`, `push ${domain}`])
		expect(pushed).toHaveLength(1)
		expect(files("7").data?.toString()).toBe(JSON.stringify({ version: 1, enabled: true }))
	})

	it("refuses to enable while a PIN is set, where unsupported, when translocated, and without a session", async () => {
		await expect(setup({ pin: true }).service.enable()).resolves.toEqual({ ok: false, error: { code: "appLocked" } })
		await expect(setup({ supported: false }).service.enable()).resolves.toEqual({ ok: false, error: { code: "unsupported" } })
		await expect(setup({ session: { status: "unreadable" } }).service.enable()).resolves.toEqual({
			ok: false,
			error: { code: "noSession" }
		})

		const translocated = setup({ translocated: true })

		await expect(translocated.service.enable()).resolves.toEqual({ ok: false, error: { code: "translocated" } })
		expect(translocated.state.loads).toBe(0)
		await expect(translocated.service.state()).resolves.toMatchObject({ enabled: false, translocated: true })
	})

	it("keeps it off for the run when macOS refuses the domain as translocated", async () => {
		const { service, fail, failure, files } = setup()

		fail.add("addDomain")
		failure.domain = "NSFileProviderErrorDomain"
		failure.code = -2002

		await expect(service.enable()).resolves.toEqual({ ok: false, error: { code: "translocated" } })
		expect(files("7").data).toBeNull()
		await expect(service.state()).resolves.toMatchObject({ enabled: false, translocated: true })

		fail.delete("addDomain")
		await expect(service.enable()).resolves.toEqual({ ok: false, error: { code: "translocated" } })
	})

	it("answers a domain macOS added switched off, and the switch once the user turned it on", async () => {
		const { service, added, domains } = setup()

		added.userEnabled = false

		await expect(service.enable()).resolves.toMatchObject({ ok: true, value: { enabled: true, userEnabled: false } })

		domains.set(domain, { identifier: domain, displayName: "user@example.com", userEnabled: true })
		await expect(service.state()).resolves.toMatchObject({ enabled: true, userEnabled: true })
	})

	it("clears the session before removing the domain on disable", async () => {
		const { service, calls, files, infos } = setup()

		await service.enable()
		calls.length = 0
		infos.length = 0

		const state = await service.disable()

		expect(calls).toEqual([`clear ${domain}`, `remove ${domain}`])
		expect(infos.slice(0, 2)).toEqual(["file provider: session cleared", "file provider: domain removed"])
		expect(state).toMatchObject({ ok: true, value: { enabled: false } })
		expect(files("7").data).toBeNull()
	})

	it("removes the domain when the clear fails, and clears on the next registration", async () => {
		const { service, calls, fail, clearOwed, infos } = setup()

		await service.enable()
		fail.add("clearAuth")
		await service.signedOut("7")

		expect(calls.slice(-2)).toEqual([`clear ${domain}`, `remove ${domain}`])
		expect(infos).not.toContain("file provider: session cleared")
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

		await expect(service.disable()).resolves.toEqual({ ok: false, error: { code: "unknown", message: "FilenFileProvider 3" } })
		expect(files("7").data).toBeNull()
	})

	it("reports what macOS says about the domain", async () => {
		const { service, domains } = setup()

		await service.enable()
		domains.set(domain, { identifier: domain, displayName: "user@example.com", userEnabled: false })

		await expect(service.state()).resolves.toEqual({
			supported: true,
			enabled: true,
			lockBlocked: false,
			userEnabled: false,
			translocated: false
		})
		await expect(setup({ supported: false, translocated: true }).service.state()).resolves.toEqual({
			supported: false,
			enabled: false,
			lockBlocked: false,
			userEnabled: null,
			translocated: false
		})
	})

	it("opens the user's directory in Finder", async () => {
		const { service, state } = setup()

		await service.enable()

		await expect(service.reveal()).resolves.toEqual({ ok: true, value: null })
		expect(state.opened).toEqual(["/Users/a/Library/CloudStorage/Filen-user@example.com"])
	})

	it("answers notFound while off, before macOS made the directory, and when Finder cannot open it", async () => {
		const { service, state } = setup()

		await expect(service.reveal()).resolves.toEqual({ ok: false, error: { code: "notFound" } })
		expect(state.loads).toBe(0)

		await service.enable()
		state.cloudStorage = ["iCloud Drive"]
		await expect(service.reveal()).resolves.toEqual({ ok: false, error: { code: "notFound" } })

		state.cloudStorage = ["Filen-user@example.com"]
		state.openFailure = "Failed to open path"
		await expect(service.reveal()).resolves.toEqual({ ok: false, error: { code: "notFound" } })
		expect(state.opened).toHaveLength(1)
	})

	it("opens System Settings only where supported", async () => {
		const supported = setup()
		const unsupported = setup({ supported: false })

		await supported.service.openSettings()
		await unsupported.service.openSettings()

		expect(supported.state.settingsOpened).toBe(1)
		expect(unsupported.state.settingsOpened).toBe(0)
	})
})

describe("fileProviderErrorCode", () => {
	function nsError(domain: string, code: number): Error {
		return Object.assign(new Error("failed"), { domain, code })
	}

	it("maps the system's errors by domain and code", () => {
		expect(fileProviderErrorCode(nsError("NSFileProviderErrorDomain", -2002))).toBe("translocated")
		expect(fileProviderErrorCode(nsError("NSFileProviderErrorDomain", -2001))).toBe("extensionMissing")
		expect(fileProviderErrorCode(nsError("NSFileProviderErrorDomain", -2014))).toBe("extensionMissing")
		expect(fileProviderErrorCode(nsError("NSFileProviderErrorDomain", -1000))).toBe("unknown")
		expect(fileProviderErrorCode(nsError("FilenFileProvider", 4))).toBe("timeout")
		expect(fileProviderErrorCode(nsError("FilenFileProvider", 3))).toBe("unknown")
		expect(fileProviderErrorCode(nsError("NSCocoaErrorDomain", -2002))).toBe("unknown")
	})

	it("maps main's own refusals, and anything else to unknown", () => {
		expect(fileProviderErrorCode(Object.assign(new Error("app lock set"), { code: "app lock set" }))).toBe("appLocked")
		expect(fileProviderErrorCode(Object.assign(new Error("x"), { code: "EACCES" }))).toBe("unknown")
		expect(fileProviderErrorCode("thrown string")).toBe("unknown")
	})
})

describe("fileProviderDirectory", () => {
	it("finds the release build's directory first, then any Filen build's", () => {
		expect(fileProviderDirectory(["Filen Dev-a@b.c", "Filen-a@b.c"], "a@b.c")).toBe("Filen-a@b.c")
		expect(fileProviderDirectory(["iCloud Drive", "Filen Dev-a@b.c"], "a@b.c")).toBe("Filen Dev-a@b.c")
	})

	it("never takes another account's directory or another provider's", () => {
		expect(fileProviderDirectory(["Filen-other@b.c", "Dropbox-a@b.c"], "a@b.c")).toBeNull()
		expect(fileProviderDirectory([], "a@b.c")).toBeNull()
	})

	it("compares names in NFC", () => {
		expect(fileProviderDirectory(["Filen-jose\u0301@b.c"], "jos\u00e9@b.c")).toBe("Filen-jose\u0301@b.c")
	})
})

describe("runsTranslocated", () => {
	it("is true for a packaged app run from a translocated copy or a disk image", () => {
		const app = "/Contents/Resources/app.asar"

		expect(
			runsTranslocated({
				packaged: true,
				inApplications: false,
				appPath: `/private/var/folders/x/AppTranslocation/y/d/Filen.app${app}`
			})
		).toBe(true)
		expect(runsTranslocated({ packaged: true, inApplications: false, appPath: `/Volumes/Filen/Filen.app${app}` })).toBe(true)
	})

	it("is false in Applications, elsewhere on disk, and for development runs", () => {
		const app = "/Contents/Resources/app.asar"

		expect(runsTranslocated({ packaged: true, inApplications: true, appPath: `/Applications/Filen.app${app}` })).toBe(false)
		expect(runsTranslocated({ packaged: true, inApplications: false, appPath: `/Users/a/Desktop/Filen.app${app}` })).toBe(false)
		expect(runsTranslocated({ packaged: false, inApplications: false, appPath: "/Volumes/Code/filen-desktop" })).toBe(false)
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

	it("registers reveal and openSettings with the same checks", async () => {
		const { main, handlers } = ipc()
		const { service, state } = setup()

		registerFileProviderIpc(main, service, url => url === "filen://app/")

		const reveal = handlers.get(fileProviderChannel("reveal"))
		const openSettings = handlers.get(fileProviderChannel("openSettings"))

		await expect(Promise.resolve(reveal?.(event("filen://app/")))).resolves.toEqual({ ok: false, error: { code: "notFound" } })
		await Promise.resolve(openSettings?.(event("filen://app/")))
		expect(state.settingsOpened).toBe(1)
		expect(() => openSettings?.(event("https://example.com/"))).toThrow("untrusted sender")
		expect(() => reveal?.(event("filen://app/"), "/etc")).toThrow("invalid file provider payload")
	})
})
