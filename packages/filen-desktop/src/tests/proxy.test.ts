import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PROXY_PROBE_URL, proxyEnv, proxyFromPac, resolveHostProxy } from "../main/proxy.ts"

describe("proxyFromPac", () => {
	it.each([
		["PROXY proxy.corp:8080", "http://proxy.corp:8080"],
		["HTTPS secure.corp:443", "https://secure.corp"],
		["HTTPS secure.corp:8443", "https://secure.corp:8443"],
		["proxy 10.0.0.1:3128; DIRECT", "http://10.0.0.1:3128"],
		["  PROXY [fd00::1]:3128 ;PROXY backup:3128", "http://[fd00::1]:3128"]
	])("takes %s as %s", (result, expected) => {
		expect(proxyFromPac(result)).toBe(expected)
	})

	it.each([
		"DIRECT",
		"",
		"DIRECT; PROXY proxy.corp:8080",
		"SOCKS5 socks.corp:1080",
		"SOCKS socks.corp:1080",
		"PROXY",
		"PROXY user:pass@proxy.corp:8080",
		"PROXY proxy.corp:8080/path",
		"PROXY proxy.corp:notaport"
	])("goes direct for %j", result => {
		expect(proxyFromPac(result)).toBeNull()
	})
})

describe("proxyEnv", () => {
	it("adds nothing without a proxy", () => {
		expect(proxyEnv({}, null)).toEqual({})
	})

	it("sets the proxy and keeps loopback direct", () => {
		expect(proxyEnv({ PATH: "/usr/bin" }, "http://proxy.corp:8080")).toEqual({
			HTTPS_PROXY: "http://proxy.corp:8080",
			NO_PROXY: "localhost,127.0.0.1,::1"
		})
	})

	it.each([{ HTTPS_PROXY: "http://mine:1" }, { https_proxy: "http://mine:1" }])("leaves a proxy the user set alone: %j", env => {
		expect(proxyEnv(env, "http://proxy.corp:8080")).toEqual({})
	})

	it("takes an empty user proxy as unset", () => {
		expect(proxyEnv({ HTTPS_PROXY: " " }, "http://proxy.corp:8080")["HTTPS_PROXY"]).toBe("http://proxy.corp:8080")
	})

	it("keeps the user's NO_PROXY entries, under the user's spelling, adding only missing loopback", () => {
		expect(proxyEnv({ no_proxy: ".corp, localhost" }, "http://proxy.corp:8080")).toEqual({
			HTTPS_PROXY: "http://proxy.corp:8080",
			no_proxy: ".corp,localhost,127.0.0.1,::1"
		})
		expect(proxyEnv({ NO_PROXY: "localhost,127.0.0.1,::1" }, "http://proxy.corp:8080")["NO_PROXY"]).toBe("localhost,127.0.0.1,::1")
	})
})

describe("resolveHostProxy", () => {
	const log = { info: vi.fn<(message: string) => void>(), warn: vi.fn<(message: string) => void>() }

	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("asks for the API's address and adds the proxy to the host's environment", async () => {
		const resolve = vi.fn<(url: string) => Promise<string>>(() => Promise.resolve("PROXY proxy.corp:8080"))
		const env = { PATH: "/usr/bin" }
		const proxy = resolveHostProxy({ env, resolve, log, waitMs: 3000 })

		expect(proxy.env()).toBe(env)
		await proxy.ready
		expect(resolve).toHaveBeenCalledWith(PROXY_PROBE_URL)
		expect(proxy.env()).toEqual({ PATH: "/usr/bin", HTTPS_PROXY: "http://proxy.corp:8080", NO_PROXY: "localhost,127.0.0.1,::1" })
		expect(env).toEqual({ PATH: "/usr/bin" })
	})

	it("keeps the app's environment for DIRECT and for a failed lookup", async () => {
		const env = { PATH: "/usr/bin" }
		const direct = resolveHostProxy({ env, resolve: () => Promise.resolve("DIRECT"), log, waitMs: 3000 })
		const failed = resolveHostProxy({ env, resolve: () => Promise.reject(new Error("pac failed")), log, waitMs: 3000 })

		await direct.ready
		await failed.ready
		expect(direct.env()).toBe(env)
		expect(failed.env()).toBe(env)
		expect(log.warn).toHaveBeenCalledWith("proxy: not resolved: pac failed")
	})

	it("stops waiting for a slow answer, which later hosts still get", async () => {
		const answer = Promise.withResolvers<string>()
		const proxy = resolveHostProxy({ env: {}, resolve: () => answer.promise, log, waitMs: 3000 })
		let ready = false

		void proxy.ready.then(() => {
			ready = true
		})
		await vi.advanceTimersByTimeAsync(2999)
		expect(ready).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		expect(ready).toBe(true)
		expect(proxy.env()["HTTPS_PROXY"]).toBeUndefined()

		answer.resolve("PROXY proxy.corp:8080")
		await vi.advanceTimersByTimeAsync(0)
		expect(proxy.env()["HTTPS_PROXY"]).toBe("http://proxy.corp:8080")
	})
})
