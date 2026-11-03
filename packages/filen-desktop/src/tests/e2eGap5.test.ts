import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { request } from "node:http"
import { type AddressInfo, connect, createServer, type Server, type Socket } from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { parseAuthority, startConnectProxy, type ConnectProxy } from "../../scripts/ci/e2e/connectProxy.ts"
import { nothingSeen } from "../../scripts/ci/e2e/extraPair.ts"
import { lockScript } from "../../scripts/ci/e2e/fileLock.ts"
import {
	addedVolumeOf,
	apfsContainerOf,
	diskpartCreate,
	diskpartRemove,
	freeBytes,
	freeDriveLetter
} from "../../scripts/ci/e2e/smallVolume.ts"
import { allIdle, proxyLaunch, tunnelsPerHost } from "../../scripts/ci/e2e/chains/proxyCheck.ts"
import { MAX_LOGINS_PER_RUN, plan, type PlanInput, QUOTA_ENTRY, SESSION_SLOTS, STEP_MINUTES } from "../../scripts/ci/e2ePlan.ts"
import { LEASE_MS, leaseName, leaseStart, leaseState } from "../../scripts/ci/e2e/quotaLease.ts"

// The pure parts of the gap-5 checks (plan D3): the CONNECT proxy and its faults against a local echo server, the
// small volumes' tool scripts and parsers, the lock holder's script, the plan's quota entry and the workflow's wiring.
// Nothing here installs, launches or mounts anything.

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup()
	}
})

// An echo server on 127.0.0.1: every byte comes back. With `banner`, it speaks first (as a TLS server's reply would).
async function echoServer(banner?: Buffer): Promise<number> {
	const server: Server = createServer(socket => {
		socket.on("error", () => undefined)

		if (banner !== undefined) {
			socket.write(banner)
		}

		socket.pipe(socket)
	})

	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))

	return (server.address() as AddressInfo).port
}

async function proxy(): Promise<ConnectProxy> {
	const started = await startConnectProxy(() => undefined)

	cleanups.push(() => started.close())

	return started
}

// A tunnel through `via` to 127.0.0.1:`port`, after the proxy's 200.
async function tunnel(via: ConnectProxy, port: number): Promise<Socket> {
	const socket = connect(via.port, "127.0.0.1")

	cleanups.push(() => {
		socket.destroy()
	})
	socket.write(`CONNECT 127.0.0.1:${String(port)} HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\n\r\n`)

	await new Promise<void>((resolve, reject) => {
		let head = ""
		const onData = (chunk: Buffer) => {
			head += chunk.toString("latin1")

			if (head.includes("\r\n\r\n")) {
				socket.off("data", onData)

				if (!head.startsWith("HTTP/1.1 200")) {
					reject(new Error(head))
				}

				resolve()
			}
		}

		socket.on("data", onData)
		socket.once("error", reject)
	})

	return socket
}

// Everything the socket reads until `bytes` arrived or it closed, and how it ended.
function readUntil(socket: Socket, bytes: number): Promise<{ data: Buffer; end: string }> {
	return new Promise(resolve => {
		const chunks: Buffer[] = []
		let length = 0
		const done = (end: string) => resolve({ data: Buffer.concat(chunks), end })

		socket.on("data", (chunk: Buffer) => {
			chunks.push(chunk)
			length += chunk.length

			if (length >= bytes) {
				done("complete")
			}
		})
		socket.once("error", error => done(`error ${(error as NodeJS.ErrnoException).code ?? error.message}`))
		socket.once("close", () => done("closed"))
	})
}

describe("e2e CONNECT proxy", () => {
	it("parses CONNECT authorities", () => {
		expect(parseAuthority("gateway.filen.io:443")).toEqual({ host: "gateway.filen.io", port: 443 })
		expect(parseAuthority("Ingest.Filen.IO:443")).toEqual({ host: "ingest.filen.io", port: 443 })
		expect(parseAuthority("[::1]:8443")).toEqual({ host: "::1", port: 8443 })
		expect(parseAuthority("gateway.filen.io")).toBeNull()
		expect(parseAuthority("host:0")).toBeNull()
		expect(parseAuthority("host:70000")).toBeNull()
		expect(parseAuthority("/v3/user/info")).toBeNull()
	})

	it("relays a tunnel both ways and records its host, port and bytes", async () => {
		const port = await echoServer()
		const via = await proxy()
		const socket = await tunnel(via, port)
		const payload = Buffer.alloc(200_000, 7)
		const read = readUntil(socket, payload.length)

		socket.write(payload)

		const { data, end } = await read

		expect(end).toBe("complete")
		expect(data.equals(payload)).toBe(true)
		expect(via.hosts()).toEqual([`127.0.0.1:${String(port)}`])
		expect(via.tunnels()[0]).toMatchObject({ host: "127.0.0.1", port, up: payload.length, down: payload.length })
		expect(tunnelsPerHost(via)).toBe(`127.0.0.1:${String(port)} x1 (up 200000, down 200000)`)
	})

	it("refuses plain HTTP requests", async () => {
		const via = await proxy()
		const status = await new Promise<number>((resolve, reject) => {
			request({ host: "127.0.0.1", port: via.port, path: "http://example.invalid/", method: "GET" }, response => {
				response.resume()
				resolve(response.statusCode ?? 0)
			})
				.on("error", reject)
				.end()
		})

		expect(status).toBe(405)
		expect(via.tunnels()).toHaveLength(0)
	})

	it("resets the first N tunnels once they relayed so many bytes, then lets the next through", async () => {
		const port = await echoServer()
		const via = await proxy()
		const fault = via.arm({ kind: "resetAfter", host: "127.0.0.1", direction: "up", bytes: 64 * 1024, tunnels: 1 })
		const first = await tunnel(via, port)
		const firstRead = readUntil(first, 256 * 1024)

		first.write(Buffer.alloc(256 * 1024, 1))
		expect((await firstRead).end).toMatch(/^error ECONNRESET$|^closed$/)
		expect(fault.fired).toBe(1)

		const second = await tunnel(via, port)
		const secondRead = readUntil(second, 256 * 1024)

		second.write(Buffer.alloc(256 * 1024, 2))
		expect((await secondRead).end).toBe("complete")
		expect(fault.fired).toBe(1)
		expect(via.tunnels()[0]?.end).toMatch(/resetAfter/)
		fault.disarm()
	})

	it("resets every tunnel to the host while armed, open and new, and none once disarmed", async () => {
		const port = await echoServer()
		const via = await proxy()
		const open = await tunnel(via, port)
		const openRead = readUntil(open, 1)
		const fault = via.arm({ kind: "resetAll", host: "127.0.0.1" })

		expect((await openRead).end).not.toBe("complete")

		const fresh = await tunnel(via, port)
		const freshRead = readUntil(fresh, 10)

		fresh.write("0123456789")
		expect((await freshRead).end).not.toBe("complete")
		expect(fault.fired).toBe(2)
		fault.disarm()

		const after = await tunnel(via, port)
		const afterRead = readUntil(after, 10)

		after.write("0123456789")
		expect((await afterRead).end).toBe("complete")
	})

	it("holds the first reply bytes after arming, then relays them in order", async () => {
		const port = await echoServer(Buffer.from("hello"))
		const via = await proxy()
		const fault = via.arm({ kind: "holdFirstReply", host: "127.0.0.1", ms: 300 })
		const started = Date.now()
		const socket = await tunnel(via, port)
		const { data, end } = await readUntil(socket, 5)

		expect(end).toBe("complete")
		expect(data.toString()).toBe("hello")
		expect(Date.now() - started).toBeGreaterThanOrEqual(280)
		expect([fault.fired, fault.delayedMs]).toEqual([1, 300])
	})

	it("throttles every tunnel together", async () => {
		const port = await echoServer()
		const via = await proxy()
		const fault = via.arm({ kind: "throttle", bytesPerSecond: 512 * 1024 })
		const socket = await tunnel(via, port)
		const payload = Buffer.alloc(256 * 1024, 3)
		const started = Date.now()
		const read = readUntil(socket, payload.length)

		socket.write(payload)

		const { data, end } = await read

		expect(end).toBe("complete")
		expect(data.equals(payload)).toBe(true)
		// 256 KiB at 512 KiB/s, each way: at least most of half a second.
		expect(Date.now() - started).toBeGreaterThanOrEqual(350)
		expect(fault.fired).toBeGreaterThan(0)
	})

	it("starts N with the proxy for the native host, rclone and (unless asked not to) Chromium", () => {
		expect(proxyLaunch({ url: "http://127.0.0.1:4100" })).toEqual({
			env: { HTTPS_PROXY: "http://127.0.0.1:4100", NO_PROXY: "localhost,127.0.0.1" },
			args: ["--proxy-server=http://127.0.0.1:4100"]
		})
		expect(proxyLaunch({ url: "http://127.0.0.1:4100" }, false).args).toEqual([])
	})

	it("counts a sample as settled only with every pair idle and none offline", () => {
		expect(allIdle({ phases: "a:idle, b:idle(lastError)", offline: 0 })).toBe(true)
		expect(allIdle({ phases: "a:idle, b:syncing", offline: 0 })).toBe(false)
		expect(allIdle({ phases: "a:offline", offline: 1 })).toBe(false)
	})
})

describe("e2e pair watch", () => {
	it("fails on what it must not have seen and says what it saw otherwise", () => {
		const seen = { samples: 12, offline: "a:offline", error: null, attention: null, failed: 0 }

		expect(() => nothingSeen(seen, ["offline", "error"])).toThrow(/offline: a:offline/)
		expect(nothingSeen(seen, ["attention"])).toBe("no attention in 12 samples")
		expect(nothingSeen({ ...seen, offline: null }, ["offline", "error", "attention"])).toBe(
			"no offline, no error, no attention in 12 samples"
		)
	})
})

describe("e2e small volumes", () => {
	it("finds the boot disk's APFS container and the volume addVolume made", () => {
		const plist = "<dict>\n\t<key>APFSContainerReference</key>\n\t<string>disk3</string>\n\t<key>x</key>\n</dict>"

		expect(apfsContainerOf(plist)).toBe("disk3")
		expect(apfsContainerOf("<dict></dict>")).toBeNull()
		expect(addedVolumeOf("Exporting new APFS Volume\nDisk from APFS operation: disk3s7\nFinished APFS operation")).toBe("disk3s7")
		expect(addedVolumeOf("Error: -69625")).toBeNull()
	})

	it("picks a drive letter nothing uses, and scripts diskpart", () => {
		expect(freeDriveLetter(["C:\\", "D:\\"])).toBe("R")
		expect(freeDriveLetter(["C:\\", "r:\\", "S:\\"])).toBe("T")
		expect(freeDriveLetter([..."CDEFGHIJKLMNOPQRSTUVWXY"].map(letter => `${letter}:\\`))).toBeNull()

		const create = diskpartCreate("C:\\v.vhdx", 64, "R")

		expect(create.split("\r\n")).toEqual([
			'create vdisk file="C:\\v.vhdx" maximum=64 type=expandable',
			'select vdisk file="C:\\v.vhdx"',
			"attach vdisk",
			"convert mbr",
			"create partition primary",
			"format fs=ntfs quick label=FilenE2E",
			"assign letter=R",
			""
		])
		expect(diskpartRemove("C:\\v.vhdx")).toBe('select vdisk file="C:\\v.vhdx"\r\ndetach vdisk\r\n')
	})

	it("reads the free bytes of a directory's volume", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "filen-e2e-free-"))

		cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
		expect(freeBytes(dir)).toBeGreaterThan(0)
	})
})

describe("e2e file locks", () => {
	it("opens without sharing, creating and filling the file only when asked", () => {
		const existing = lockScript("C:\\p\\it's.bin", null)
		const created = lockScript("C:\\p\\new.bin", "C:\\work\\new.bin")

		expect(existing).toContain("[IO.File]::Open('C:\\p\\it''s.bin', 'Open', 'ReadWrite', 'None')")
		expect(existing).not.toContain("ReadAllBytes")
		expect(created).toContain("[IO.File]::Open('C:\\p\\new.bin', 'CreateNew', 'ReadWrite', 'None')")
		expect(created).toContain("[IO.File]::ReadAllBytes('C:\\work\\new.bin')")
		// Held until stdin closes or says release; the hash is read through the holder's own handle.
		expect(created).toMatch(/\$null -eq \$line -or \$line -eq 'release'/)
		expect(created).toContain("ComputeHash($file)")
		expect(created.trimEnd().endsWith("$file.Close()")).toBe(true)
	})
})

describe("e2e plan: the quota account's check", () => {
	const dispatch: PlanInput = {
		platforms: "windows,mac,linux",
		profile: "custom",
		eventName: "workflow_dispatch",
		signed: true,
		scenarios: "previous,legacy",
		legacy: true,
		formats: "",
		depth: "",
		spike: "none",
		signin: "",
		day: 0
	}
	const quotaOf = (input: PlanInput) =>
		plan(input)
			.tests.filter(entry => entry.quota)
			.map(entry => `${entry.platform}-${entry.arch}-${entry.format}`)

	it("runs on chain P of linux-x64-deb only, counted as one more login", () => {
		expect(QUOTA_ENTRY).toBe("linux-x64-deb")
		expect(quotaOf(dispatch)).toEqual(["linux-x64-deb"])
		expect(quotaOf({ ...dispatch, profile: "", eventName: "schedule", platforms: "" })).toEqual(["linux-x64-deb"])
		expect(plan(dispatch).logins).toBe(SESSION_SLOTS + 6 + 1)
		// No chain P, no spike, no deep: none.
		expect(quotaOf({ ...dispatch, scenarios: "legacy" })).toEqual([])
		expect(quotaOf({ ...dispatch, spike: "offline" })).toEqual([])
		expect(quotaOf({ ...dispatch, depth: "install" })).toEqual([])
		expect(quotaOf({ ...dispatch, platforms: "windows,mac" })).toEqual([])
		expect(plan({ ...dispatch, scenarios: "legacy" }).logins).toBe(SESSION_SLOTS + 3)
	})

	it("is skipped with a notice when the run's sign-ins already reach the cap", () => {
		const full = plan({ ...dispatch, platforms: "linux", depth: "deep", signin: "real" })

		expect(full.logins).toBe(MAX_LOGINS_PER_RUN)
		expect(full.tests.some(entry => entry.quota)).toBe(false)
		expect(full.notices.some(notice => notice.startsWith("The cloud-storage-full check is skipped"))).toBe(true)
	})
})

describe("e2e quota lease", () => {
	const now = 1_800_000_000_000

	it("names a lease so that the earliest sorts first", () => {
		const name = leaseName(now, "123-1", "ab12cd34")

		expect(name).toBe("001800000000000-123-1-ab12cd34")
		expect(leaseStart(name)).toBe(now)
		expect(leaseStart("filler.bin")).toBe(null)
		expect(leaseName(now - 1, "999-1", "ff").localeCompare(name)).toBeLessThan(0)
	})

	it("gives the account to the earliest unexpired lease and expires the rest past the lease time", () => {
		const old = leaseName(now - LEASE_MS - 1, "1-1", "aa")
		const first = leaseName(now - 1000, "2-1", "bb")
		const second = leaseName(now, "3-1", "cc")

		expect(leaseState([second, old, "stray", first], now)).toEqual({ expired: [old, "stray"], holder: first })
		expect(leaseState([], now)).toEqual({ expired: [], holder: null })
		// Two runs listing the same two leases agree on the holder.
		expect(leaseState([first, second], now).holder).toBe(leaseState([second, first], now).holder)
	})
})

describe("e2e workflow: the gap-5 checks", () => {
	const text = readFileSync(fileURLToPath(new URL("../../../../.github/workflows/desktop-e2e.yml", import.meta.url)), "utf8")
	const step = text.slice(text.indexOf("- name: N-1 -> N, signed in"), text.indexOf("- name: N-1 -> N (Fedora container)"))

	it("hands the quota account and the plan's choice to chain P's deep step only", () => {
		expect(step).toContain("E2E_QUOTA: ${{ matrix.quota && '1' || '' }}")
		expect(step).toContain("FILEN_DESKTOP_E2E_QUOTA_EMAIL: ${{ secrets.FILEN_DESKTOP_E2E_QUOTA_EMAIL }}")
		expect(step).toContain("FILEN_DESKTOP_E2E_QUOTA_PASSWORD: ${{ secrets.FILEN_DESKTOP_E2E_QUOTA_PASSWORD }}")
		expect(text.split("FILEN_DESKTOP_E2E_QUOTA_EMAIL: ${{").length - 1).toBe(2)
	})

	it("keeps the chain's budget below its step's timeout, and both chains below the job's", () => {
		const budget = Number(/E2E_CHAIN_BUDGET_MINUTES: (\d+)/.exec(step)?.[1])
		const timeout = Number(/timeout-minutes: (\d+)/.exec(step)?.[1])
		const legacy = text.slice(text.indexOf("- name: 3.0.53 -> N, signed in"))
		const legacyTimeout = Number(/timeout-minutes: (\d+)/.exec(legacy)?.[1])

		expect(budget).toBeLessThan(timeout)
		expect(timeout).toBe(STEP_MINUTES.previousDeep)
		expect(legacyTimeout).toBe(STEP_MINUTES.legacyDeep)
		expect(text).toContain("timeout-minutes: ${{ matrix.timeout }}")
	})
})
