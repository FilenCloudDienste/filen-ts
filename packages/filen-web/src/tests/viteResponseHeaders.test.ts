import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createServer as createHttpServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, preview, type Plugin, type PreviewServer, type UserConfig, type ViteDevServer } from "vite"

// WebKit judges a revalidated worker script by the 304's own headers, so a bare 304 keeps a worker from
// starting again in the same page. Vite sends its configured headers only with a body; the config's
// response-headers plugin has to put them on the 304 too, on the dev server and the preview server.

const ISOLATION = ["cross-origin-opener-policy", "cross-origin-embedder-policy", "cross-origin-resource-policy"]

async function config(command: "serve" | "build"): Promise<UserConfig> {
	const factory = (await import("../../vite.config")).default

	return factory({ mode: "development", command, isPreview: command === "build" })
}

async function responseHeadersPlugin(command: "serve" | "build"): Promise<Plugin> {
	const plugin = ((await config(command)).plugins ?? [])
		.flat()
		.find(
			(entry): entry is Plugin =>
				typeof entry === "object" && entry !== null && "name" in entry && entry.name === "filen:response-headers"
		)

	if (plugin === undefined) {
		throw new Error("filen:response-headers is not in the Vite config")
	}

	return plugin
}

// The first fetch of `path`, then a conditional one with its ETag.
async function revalidate(origin: string, path: string): Promise<{ first: Response; second: Response }> {
	const first = await fetch(origin + path)
	const etag = first.headers.get("etag")

	expect(first.status).toBe(200)
	expect(etag).not.toBeNull()

	const second = await fetch(origin + path, { headers: { "If-None-Match": etag ?? "" } })

	return { first, second }
}

let root = ""

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "filen-web-headers-"))
	mkdirSync(join(root, "dist"))
	writeFileSync(join(root, "worker.js"), "self.postMessage(1)\n")
	writeFileSync(join(root, "dist", "worker.js"), "self.postMessage(1)\n")
	mkdirSync(join(root, "dist", "assets"))
	writeFileSync(join(root, "dist", "assets", "mermaid-frame-0123abcd.js"), "void 0\n")
})

afterAll(() => {
	rmSync(root, { recursive: true, force: true })
})

describe("response headers on 304 Not Modified", () => {
	let dev: ViteDevServer | undefined
	let http: Server | undefined
	let previewServer: PreviewServer | undefined

	afterAll(async () => {
		http?.close()
		await dev?.close()
		await previewServer?.close()
	})

	it("dev server", async () => {
		dev = await createServer({
			configFile: false,
			root,
			logLevel: "silent",
			plugins: [await responseHeadersPlugin("serve")],
			optimizeDeps: { noDiscovery: true, entries: [] },
			server: { ...(await config("serve")).server, middlewareMode: true, hmr: false, ws: false }
		})
		http = createHttpServer(dev.middlewares)
		await new Promise<void>(resolve => http?.listen(0, "127.0.0.1", resolve))

		const { port } = http.address() as AddressInfo
		const { second } = await revalidate(`http://127.0.0.1:${String(port)}`, "/worker.js")

		expect(second.status).toBe(304)

		for (const name of [...ISOLATION, "service-worker-allowed"]) {
			expect(second.headers.get(name), name).not.toBeNull()
		}
	})

	it("preview server", async () => {
		previewServer = await preview({
			configFile: false,
			root,
			logLevel: "silent",
			plugins: [await responseHeadersPlugin("build")],
			build: { outDir: "dist" },
			// The config's own file headers, which the static handler sends after the plugin's.
			preview: { headers: (await config("build")).preview?.headers ?? {}, host: "127.0.0.1", port: 0, open: false }
		})

		const { port } = previewServer.httpServer.address() as AddressInfo
		const { second } = await revalidate(`http://127.0.0.1:${String(port)}`, "/worker.js")

		expect(second.status).toBe(304)

		for (const name of [...ISOLATION, "content-security-policy"]) {
			expect(second.headers.get(name), name).not.toBeNull()
		}

		// The diagram frame's script alone may be embedded cross-origin (its frame's origin is opaque).
		const frame = await revalidate(`http://127.0.0.1:${String(port)}`, "/assets/mermaid-frame-0123abcd.js")

		expect(frame.first.headers.get("cross-origin-resource-policy")).toBe("cross-origin")
		expect(frame.second.headers.get("cross-origin-resource-policy")).toBe("cross-origin")
		expect(second.headers.get("cross-origin-resource-policy")).toBe("same-origin")
	})
})
