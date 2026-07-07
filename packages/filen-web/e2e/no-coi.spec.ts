import { createServer, type Server } from "node:http"
import { readFileSync, statSync } from "node:fs"
import { extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import type { AddressInfo } from "node:net"
import { test, expect } from "@playwright/test"

const DIST = fileURLToPath(new URL("../dist", import.meta.url))

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".wasm": "application/wasm",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
	".map": "application/json; charset=utf-8"
}

interface PlainServer {
	server: Server
	baseUrl: string
}

// Serves the built app WITHOUT the COI headers that preview adds, so `self.crossOriginIsolated` is
// false and the SDK worker's boot returns the `coi` reason — the app then routes to /no-coi. All SDK
// artifacts still resolve (preflight passes), so the failure is specifically COI, not missing
// artifacts.
function startPlainServer(): Promise<PlainServer> {
	const server = createServer((req, res) => {
		const urlPath = (req.url ?? "/").split("?")[0] ?? "/"
		const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "")
		let filePath = join(DIST, rel === "/" ? "index.html" : rel)

		if (!filePath.startsWith(DIST)) {
			res.writeHead(403).end()

			return
		}

		try {
			if (statSync(filePath).isDirectory()) {
				filePath = join(filePath, "index.html")
			}

			const body = readFileSync(filePath)

			res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" })
			res.end(req.method === "HEAD" ? undefined : body)
		} catch {
			res.writeHead(404).end()
		}
	})

	return new Promise(resolve => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo

			resolve({ server, baseUrl: `http://127.0.0.1:${String(port)}` })
		})
	})
}

test.describe("no cross-origin isolation", { tag: "@capability" }, () => {
	let plain: PlainServer

	test.beforeAll(async () => {
		plain = await startPlainServer()
	})

	test.afterAll(async () => {
		await new Promise<void>(resolve => {
			plain.server.close(() => {
				resolve()
			})
		})
	})

	test("serving without COI headers routes to the no-COI page", async ({ page }) => {
		await page.goto(`${plain.baseUrl}/`)

		await expect(page.getByText("Unable to start Filen securely")).toBeVisible()
	})

	test("a blocked SDK worker artifact shows the boot error with the artifacts reason", async ({ page }) => {
		await page.route("**/filen-sdk-worker-thread.js", route => route.abort())

		await page.goto("/")

		await expect(page.getByText("Filen could not start")).toBeVisible()
		await expect(page.getByText("artifacts", { exact: true })).toBeVisible()
	})
})
