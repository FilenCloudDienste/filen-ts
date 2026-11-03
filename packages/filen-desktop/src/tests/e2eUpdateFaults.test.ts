import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { get } from "node:http"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { faultPlan, faultSteps, logMark, logSince, pendingProblems, stepLogProblems } from "../../scripts/ci/e2e/updateFaults.ts"
import { describeProcesses, INSTALL_SIGNS, installSigns, type InstallProbe, processesAt, textFrom } from "../../scripts/ci/e2e/update.ts"
import { serveFeed, type FeedFaultPlan, type FeedServer } from "../../scripts/ci/support.ts"
import type { Target } from "../../scripts/ci/targets.ts"
import { TEST_UPDATE_CHECK_INTERVAL_MS, UPDATE_STALL_MS } from "../../src/main/updater.ts"

const dirs: string[] = []
const servers: FeedServer[] = []

function tempDir(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "filen-e2e-faults-"))

	dirs.push(dir)

	return dir
}

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.release()
		await server.close()
	}

	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true })
	}
})

interface Fetched {
	status: number
	length: number
	body: Buffer
	// The response ended short of its Content-Length (the socket went away).
	broken: boolean
}

// One GET; `onData` sees the bytes as they come.
function fetchRaw(url: string, headers: Record<string, string> = {}, onData?: (received: number) => void): Promise<Fetched> {
	return new Promise((resolve, reject) => {
		get(url, { headers, agent: false }, response => {
			const chunks: Buffer[] = []
			let received = 0
			const done = (broken: boolean) => {
				const body = Buffer.concat(chunks)

				resolve({ status: response.statusCode ?? 0, length: Number(response.headers["content-length"] ?? -1), body, broken })
			}

			response.on("data", (chunk: Buffer) => {
				chunks.push(chunk)
				received += chunk.length
				onData?.(received)
			})
			response.on("end", () => done(false))
			response.on("aborted", () => done(true))
			response.on("error", () => done(true))
		}).on("error", reject)
	})
}

async function feed(plan: FeedFaultPlan, size = 64 * 1024): Promise<{ server: FeedServer; data: Buffer }> {
	const dir = tempDir()
	const data = Buffer.alloc(size)

	for (let index = 0; index < size; index++) {
		data[index] = index % 251
	}

	writeFileSync(path.join(dir, "file.bin"), data)
	writeFileSync(path.join(dir, "latest.yml"), "version: 1.0.0\n")

	const server = await serveFeed(dir, ["file.bin", "latest.yml"], plan)

	servers.push(server)

	return { server, data }
}

describe("e2e feed faults", () => {
	it("answers a status fault without a body and counts ordinals per name", async () => {
		const seen: string[] = []
		const { server } = await feed(({ name, ordinal, range }) => {
			seen.push(`${name}#${String(ordinal)}${range ? " range" : ""}`)

			return name === "latest.yml" && ordinal === 1 ? { status: 500 } : null
		})

		expect((await fetchRaw(`${server.url}latest.yml`)).status).toBe(500)
		expect((await fetchRaw(`${server.url}latest.yml`)).status).toBe(200)
		await fetchRaw(`${server.url}file.bin`, { range: "bytes=0-9" })
		expect(seen).toEqual(["latest.yml#1", "latest.yml#2", "file.bin#1 range"])
		expect(server.requests.map(request => request.status)).toEqual([500, 200, 200])
	})

	it("serves a body instead of the file, and inverts exactly one byte at flipAt", async () => {
		const { server, data } = await feed(({ name }) => (name === "latest.yml" ? { body: Buffer.from("made up\n") } : { flipAt: 0.5 }))

		expect((await fetchRaw(`${server.url}latest.yml`)).body.toString()).toBe("made up\n")

		const flipped = await fetchRaw(`${server.url}file.bin`)
		const differing = [...flipped.body.keys()].filter(index => flipped.body[index] !== data[index])

		expect(flipped.body.length).toBe(data.length)
		expect(differing).toEqual([data.length / 2])
		expect(flipped.body[data.length / 2]).toBe((data[data.length / 2] ?? 0) ^ 0xff)
	})

	it("cuts the socket at cutAt with the full Content-Length announced", async () => {
		const { server, data } = await feed(() => ({ cutAt: 0.4 }))
		const cut = await fetchRaw(`${server.url}file.bin`)

		expect(cut.length).toBe(data.length)
		expect(cut.broken).toBe(true)
		expect(cut.body.length).toBeLessThanOrEqual(Math.floor(data.length * 0.4))
		expect(server.requests[0]?.bytes).toBe(Math.floor(data.length * 0.4))
	})

	it("stalls at stallAt on a live socket until release(), then destroys it, never sending the rest", async () => {
		const { server, data } = await feed(() => ({ stallAt: 0.3 }))
		const stallBytes = Math.floor(data.length * 0.3)
		let reachedStall: () => void = () => undefined
		const atStall = new Promise<void>(resolve => {
			reachedStall = resolve
		})
		const pending = fetchRaw(`${server.url}file.bin`, {}, received => {
			if (received >= stallBytes) {
				reachedStall()
			}
		})

		await atStall
		await new Promise(resolve => setTimeout(resolve, 200))
		expect(server.requests[0]?.bytes).toBe(stallBytes)
		server.release()

		const cut = await pending

		expect(cut.broken).toBe(true)
		expect(cut.body.length).toBe(stallBytes)
		expect(server.requests[0]?.bytes).toBe(stallBytes)
	})

	it("holds a stallAt 0 response before its first byte (the step gate)", async () => {
		const { server } = await feed(() => ({ stallAt: 0 }))
		let received = -1
		const pending = fetchRaw(`${server.url}latest.yml`, {}, count => {
			received = count
		})

		await new Promise(resolve => setTimeout(resolve, 200))
		expect(received).toBe(-1)
		server.release()
		expect((await pending).body.toString()).toBe("version: 1.0.0\n")
	})
})

describe("e2e update fault steps", () => {
	const truncated = { manifest: Buffer.from("m"), zip: Buffer.from("z") }

	it("adds the truncated zip on macOS only, and gives the stall the watchdog's time", () => {
		expect(faultSteps("win", null).map(step => step.name)).toEqual([
			"manifest 500",
			"file 404",
			"cut at 40%",
			"one byte flipped",
			"stall at 30%",
			"ended during a stalled download"
		])

		const mac = faultSteps("mac", truncated)

		expect(mac.map(step => step.name)[4]).toBe("truncated zip")
		expect(mac.filter(step => step.squirrel).map(step => step.name)).toEqual(["truncated zip"])
		expect(mac.find(step => step.squirrel)?.nextWithinMs).toBe(3 * TEST_UPDATE_CHECK_INTERVAL_MS)
		expect(mac.filter(step => step.watchdog).map(step => step.nextWithinMs)).toEqual([
			UPDATE_STALL_MS + 3 * TEST_UPDATE_CHECK_INTERVAL_MS
		])
	})

	it("fails the truncated zip's step on any ready to install once Squirrel refused it (F2)", () => {
		const squirrel = faultSteps("mac", truncated).find(step => step.squirrel) ?? expect.fail("no Squirrel step")
		const refused = "WARN updater: Squirrel: Cannot open the update archive\n"
		const ready = "INFO updater: 4.0.1 is ready to install\n"

		expect(stepLogProblems(squirrel, refused)).toEqual([])
		expect(stepLogProblems(squirrel, "ERROR updater: check failed: archive\n")).toEqual([])
		expect(stepLogProblems(squirrel, refused + ready)).toEqual(["an update was reported ready to install"])
		expect(stepLogProblems(squirrel, "")).toEqual(["neither Squirrel's refusal nor a failed check was logged"])
	})

	it("wants exactly one failed check of the other steps, nothing ready, and the stall's watchdog line", () => {
		const [manifest500, , , , stall] = faultSteps("win", null)
		const failed = "ERROR updater: check failed: 500\n"

		expect(stepLogProblems(manifest500 ?? expect.fail("no step"), failed)).toEqual([])
		expect(stepLogProblems(manifest500 ?? expect.fail("no step"), failed + failed)).toEqual([
			'2 "check failed" lines, expected exactly one'
		])
		expect(stepLogProblems(stall ?? expect.fail("no step"), failed)).toEqual(["the no-progress watchdog logged nothing"])
	})

	it("keys the update file's fault on the manifest that came last and gates every later manifest", () => {
		const steps = faultSteps("mac", truncated)
		const plan = faultPlan(steps, "latest-mac.yml", "Filen_mac_arm64.zip")
		const manifest = (ordinal: number) => plan({ name: "latest-mac.yml", ordinal, range: false })
		const file = (ordinal: number, range = false) => plan({ name: "Filen_mac_arm64.zip", ordinal, range })

		expect(manifest(1)).toEqual({ status: 500 })
		expect(manifest(2)).toEqual({ stallAt: 0 })
		expect(file(1)).toEqual({ status: 404 })
		expect(manifest(3)).toEqual({ stallAt: 0 })
		expect(file(2, true)).toEqual({ status: 416 })
		expect(file(3)).toEqual({ cutAt: 0.4 })
		expect(manifest(4)).toEqual({ stallAt: 0 })
		expect(file(4)).toEqual({ flipAt: 0.5 })
		expect(manifest(5)).toEqual({ body: truncated.manifest, stallAt: 0 })
		expect(file(5)).toEqual({ body: truncated.zip })
		expect(manifest(6)).toEqual({ stallAt: 0 })
		expect(file(6)).toEqual({ stallAt: 0.3 })
		expect(manifest(7)).toEqual({ stallAt: 0 })
		expect(file(7)).toEqual({ stallAt: 0.3 })
		expect(manifest(8)).toEqual({ status: 500 })
		expect(plan({ name: "Filen_mac_arm64.zip.blockmap", ordinal: 1, range: false })).toBeNull()
	})

	it("never lets a file through before any manifest", () => {
		const plan = faultPlan(faultSteps("linux", null), "latest-linux.yml", "Filen_linux_x86_64.AppImage")

		expect(plan({ name: "Filen_linux_x86_64.AppImage", ordinal: 1, range: false })).toEqual({ status: 500 })
	})
})

describe("e2e update fault evidence", () => {
	it("reads main.log past a mark, across a rotation", () => {
		const userData = tempDir()
		const logs = path.join(userData, "logs")

		mkdirSync(logs)
		expect(logMark({ userData })).toEqual({ size: 0 })
		writeFileSync(path.join(logs, "main.log"), "old line\n")

		const mark = logMark({ userData })

		writeFileSync(path.join(logs, "main.log"), "old line\nnew line\n")
		expect(logSince({ userData }, mark)).toBe("new line\n")

		writeFileSync(path.join(logs, "main.1.log"), "old line\nnew line\nlast before rotation\n")
		writeFileSync(path.join(logs, "main.log"), "after\n")
		expect(logSince({ userData }, mark)).toBe("new line\nlast before rotation\nafter\n")
	})

	it("flags update-info.json and a full-size download in pending/, nothing else", () => {
		const updaterCache = tempDir()
		const pending = path.join(updaterCache, "pending")

		expect(pendingProblems({ updaterCache }, 100)).toEqual([])
		mkdirSync(pending)
		writeFileSync(path.join(pending, "temp-Filen_win.exe"), Buffer.alloc(30))
		expect(pendingProblems({ updaterCache }, 100)).toEqual([])
		writeFileSync(path.join(pending, "Filen_win.exe"), Buffer.alloc(100))
		writeFileSync(path.join(pending, "update-info.json"), "{}")
		expect(pendingProblems({ updaterCache }, 100).sort()).toEqual([
			"pending/Filen_win.exe is a full-size download (100 bytes)",
			"pending/update-info.json exists"
		])
	})
})

describe("e2e update install start", () => {
	// The old app as the long wait would find it: nothing logged, no installer, the old version installed.
	function probe(overrides: Partial<InstallProbe> = {}): InstallProbe {
		return {
			log: () => "",
			needles: INSTALL_SIGNS.legacy,
			installers: () => Promise.resolve([]),
			installedVersion: () => "3.0.53",
			startedVersions: () => [],
			...overrides
		}
	}

	it("finds no sign in a fetched download alone, the case where 3.x died during its update", async () => {
		await expect(
			installSigns(probe({ log: () => "[info] Checking for update\n[info] Update available\n" }), "3.0.53", "4.0.1")
		).resolves.toEqual([])
	})

	it("takes 3.x's own log lines, an installer from the updater cache, a changed install or N started", async () => {
		await expect(installSigns(probe({ log: () => "[info] Update downloaded: {}\n" }), "3.0.53", "4.0.1")).resolves.toEqual([
			'logged "Update downloaded"'
		])
		await expect(installSigns(probe({ log: () => "[info] Installing update\n" }), "3.0.53", "4.0.1")).resolves.toEqual([
			'logged "Installing update"'
		])
		await expect(
			installSigns(probe({ installers: () => Promise.resolve(["412 C:\\Users\\e2e\\Filen_win.exe --updated"]) }), "3.0.53", "4.0.1")
		).resolves.toEqual(["an installer runs: 412 C:\\Users\\e2e\\Filen_win.exe --updated"])
		await expect(installSigns(probe({ installedVersion: () => "4.0.1" }), "3.0.53", "4.0.1")).resolves.toEqual([
			"the installed app is 4.0.1"
		])
		await expect(installSigns(probe({ startedVersions: () => ["4.0.1"] }), "3.0.53", "4.0.1")).resolves.toEqual(["4.0.1 started"])
	})

	it("reads electron-updater's lines for N-1 -> N, and nothing from 3.x's", async () => {
		const current = probe({ needles: INSTALL_SIGNS.current, installedVersion: () => "4.0.0" })

		await expect(installSigns({ ...current, log: () => "INFO updater: Update downloaded\n" }, "4.0.0", "4.0.1")).resolves.toEqual([])
		await expect(
			installSigns(
				{ ...current, log: () => "INFO updater: New version 4.0.1 has been downloaded to C:\\cache\\Filen_win.exe\n" },
				"4.0.0",
				"4.0.1"
			)
		).resolves.toEqual(['logged "has been downloaded to"'])
	})

	it("counts a failed look as no sign, never as a failure", async () => {
		await expect(
			installSigns(
				probe({
					installers: () => Promise.reject(new Error("listing processes failed: timed out")),
					installedVersion: () => {
						throw new Error("app.asar is missing")
					}
				}),
				"3.0.53",
				"4.0.1"
			)
		).resolves.toEqual([])
		await expect(installSigns(probe({ installedVersion: null }), "3.0.53", "4.0.1")).resolves.toEqual([])
	})

	it("lists every main process, those without a readable path too, and counts only those at the executable", () => {
		const entries = [
			{ pid: 1, path: "C:\\Program Files\\Filen\\Filen.exe" },
			{ pid: 2, path: "" }
		]

		expect(describeProcesses(entries)).toBe("1 C:\\Program Files\\Filen\\Filen.exe, 2 (no path)")
		expect(describeProcesses([])).toBe("no main process")

		const target = {
			platform: "win",
			executable: "c:\\program files\\filen\\filen.exe",
			mainProcesses: () => entries
		} as unknown as Target

		expect(processesAt(target)).toEqual([entries[0]])
	})

	it("reads a log past an offset, all of it once it shrank", () => {
		const file = path.join(tempDir(), "desktop.log")

		expect(textFrom(file, 0)).toBe("")
		writeFileSync(file, "before\n")

		const offset = "before\n".length

		writeFileSync(file, "before\nInstalling update\n")
		expect(textFrom(file, offset)).toBe("Installing update\n")
		writeFileSync(file, "new\n")
		expect(textFrom(file, offset)).toBe("new\n")
	})
})
