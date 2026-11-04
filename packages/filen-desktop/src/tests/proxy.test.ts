import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PROXY_PROBE_URL, proxyEnv, proxyFromPac, resolveHostProxy } from "../main/proxy.ts"

describe("proxyFromPac", () => {
	it.each([
		["PROXY proxy.corp:8080", "http://proxy.corp:8080"],
		["HTTPS secure.corp:443", "https://secure.corp"],
		["HTTPS secure.corp:8443", "https://secure.corp:8443"],
		["proxy 10.0.0.1:3128; DIRECT", "http://10.0.0.1:3128"],
		["  PROXY [fd00::1]:3128 ;PROXY backup:3128", "http://[fd00::1]:3128"],
		["SOCKS5 socks.corp:1080", "socks5h://socks.corp:1080"],
		["SOCKS socks.corp:1080", "socks5h://socks.corp:1080"],
		["socks5 10.0.0.2:1080; DIRECT", "socks5h://10.0.0.2:1080"],
		["SOCKS5 [fd00::2]:1080", "socks5h://[fd00::2]:1080"]
	])("takes %s as %s", (result, expected) => {
		expect(proxyFromPac(result)).toBe(expected)
	})

	it.each([
		"DIRECT",
		"",
		"DIRECT; PROXY proxy.corp:8080",
		"QUIC quic.corp:443",
		"PROXY",
		"SOCKS5",
		"PROXY user:pass@proxy.corp:8080",
		"PROXY proxy.corp:8080/path",
		"PROXY proxy.corp:notaport",
		"SOCKS5 user:pass@socks.corp:1080",
		"SOCKS5 socks.corp:1080/path",
		"SOCKS5 socks.corp:1080#x",
		"SOCKS5 socks.corp:notaport"
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

	it("hands a SOCKS proxy on as ALL_PROXY for the SDK and HTTPS_PROXY for rclone", () => {
		expect(proxyEnv({ PATH: "/usr/bin" }, "socks5h://socks.corp:1080")).toEqual({
			ALL_PROXY: "socks5h://socks.corp:1080",
			HTTPS_PROXY: "socks5h://socks.corp:1080",
			NO_PROXY: "localhost,127.0.0.1,::1"
		})
	})

	it.each([
		{ HTTPS_PROXY: "http://mine:1" },
		{ https_proxy: "http://mine:1" },
		{ ALL_PROXY: "socks5://mine:1" },
		{ all_proxy: "socks5://mine:1" }
	])("leaves a proxy the user set alone: %j", env => {
		expect(proxyEnv(env, "http://proxy.corp:8080")).toEqual({})
		expect(proxyEnv(env, "socks5h://socks.corp:1080")).toEqual({})
	})

	it("takes an empty user proxy as unset, replacing it under its own spelling", () => {
		expect(proxyEnv({ HTTPS_PROXY: " " }, "http://proxy.corp:8080")["HTTPS_PROXY"]).toBe("http://proxy.corp:8080")
		expect(proxyEnv({ https_proxy: "", all_proxy: " ", no_proxy: "" }, "socks5h://socks.corp:1080")).toEqual({
			all_proxy: "socks5h://socks.corp:1080",
			https_proxy: "socks5h://socks.corp:1080",
			no_proxy: "localhost,127.0.0.1,::1"
		})
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

	it("adds a SOCKS answer to the host's environment", async () => {
		const proxy = resolveHostProxy({ env: {}, resolve: () => Promise.resolve("SOCKS5 socks.corp:1080"), log, waitMs: 3000 })

		await proxy.ready
		expect(proxy.env()).toEqual({
			ALL_PROXY: "socks5h://socks.corp:1080",
			HTTPS_PROXY: "socks5h://socks.corp:1080",
			NO_PROXY: "localhost,127.0.0.1,::1"
		})
		expect(log.info).toHaveBeenCalledWith("proxy: the native host uses socks5h://socks.corp:1080")
	})

	it("keeps the app's environment for a proxy the user set", async () => {
		const env = { ALL_PROXY: "socks5://mine:1" }
		const proxy = resolveHostProxy({ env, resolve: () => Promise.resolve("PROXY proxy.corp:8080"), log, waitMs: 3000 })

		await proxy.ready
		expect(proxy.env()).toBe(env)
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
