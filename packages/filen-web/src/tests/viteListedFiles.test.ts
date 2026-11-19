import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type ViteDevServer } from "vite"

// The asset plugins' dev handler: exactly the listed files, with the isolation headers; a listed file missing on disk
// is a 404, not an error thrown inside the middleware.

const { serveListedFiles } = await import("../../vite/shared")

let root = ""
let dev: ViteDevServer | undefined
let origin = ""

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "filen-web-listed-"))
	writeFileSync(join(root, "present.txt"), "hello")

	dev = await createServer({
		configFile: false,
		root,
		logLevel: "silent",
		plugins: [
			{
				name: "listed-files",
				configureServer(server) {
					serveListedFiles(server, {
						base: "/listed/",
						dir: root,
						served: new Set(["present.txt", "missing.txt"]),
						mime: () => "text/plain"
					})
				}
			}
		],
		optimizeDeps: { noDiscovery: true, entries: [] },
		// A listening server, as `vite` runs: its error middleware answers a thrown handler with a 500.
		server: { host: "127.0.0.1", port: 0, hmr: false, ws: false }
	})
	await dev.listen()

	const { port } = dev.httpServer?.address() as AddressInfo

	origin = `http://127.0.0.1:${String(port)}`
})

afterAll(async () => {
	await dev?.close()
	rmSync(root, { recursive: true, force: true })
})

describe("serveListedFiles", () => {
	it("serves a listed file with its length and the isolation headers", async () => {
		const response = await fetch(`${origin}/listed/present.txt?v=1`)

		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toBe("text/plain")
		expect(response.headers.get("content-length")).toBe("5")
		expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp")
		expect(await response.text()).toBe("hello")
	})

	it("answers 404 for a listed file missing on disk", async () => {
		const response = await fetch(`${origin}/listed/missing.txt`)

		expect(response.status).toBe(404)
	})

	it("passes an unlisted path on", async () => {
		const response = await fetch(`${origin}/listed/other.txt`)

		expect(response.headers.get("cross-origin-embedder-policy")).toBeNull()
	})
})
