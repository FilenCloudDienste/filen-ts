import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Starts filen-web's Vite dev server on a free port, then Electron with the app's protocol proxying to it (serve.ts), so
// the page hot-reloads and React reports unminified errors. Arguments go to Electron. `pnpm run dev:dist` serves the
// built filen-web/dist instead, with the deployment's headers (CSP included).
//
//   node scripts/dev.ts [electron args…]

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const webDir = path.join(packageDir, "../filen-web")
const READY_TIMEOUT_MS = 60_000

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer()

		server.once("error", reject)
		server.listen(0, "localhost", () => {
			const address = server.address()

			server.close(() => {
				if (address === null || typeof address === "string") {
					reject(new Error("no port"))
				} else {
					resolve(address.port)
				}
			})
		})
	})
}

async function waitForServer(url: string, vite: ChildProcess): Promise<void> {
	const deadline = Date.now() + READY_TIMEOUT_MS

	while (Date.now() < deadline) {
		if (vite.exitCode !== null) {
			throw new Error(`vite exited with ${String(vite.exitCode)}`)
		}

		try {
			await fetch(url)

			return
		} catch {
			await new Promise(resolve => setTimeout(resolve, 200))
		}
	}

	throw new Error(`vite did not answer on ${url}`)
}

const port = await freePort()
const url = `http://localhost:${String(port)}`
const viteBin = path.join(path.dirname(createRequire(path.join(webDir, "package.json")).resolve("vite/package.json")), "bin/vite.js")
const vite = spawn(process.execPath, [viteBin, "--port", String(port), "--strictPort", "--host", "localhost"], {
	cwd: webDir,
	stdio: "inherit",
	env: { ...process.env, FILEN_DESKTOP_HMR_PORT: String(port) }
})

try {
	await waitForServer(url, vite)
} catch (error) {
	vite.kill()
	throw error
}

const electronPath: unknown = createRequire(import.meta.url)("electron")

if (typeof electronPath !== "string") {
	vite.kill()
	throw new Error("electron binary not found")
}

const electron = spawn(electronPath, [".", ...process.argv.slice(2)], {
	cwd: packageDir,
	stdio: "inherit",
	env: { ...process.env, FILEN_DESKTOP_WEB_DEV_URL: url }
})

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		electron.kill(signal)
	})
}

electron.on("exit", code => {
	vite.kill()
	process.exitCode = code ?? 1
})
