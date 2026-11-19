import { createHash } from "node:crypto"
import { createReadStream, stat } from "node:fs"
import { join } from "node:path"
import type { ViteDevServer } from "vite"

// What the Vite asset plugins share: the isolation headers, manifest reading and pin checks, and the dev server's
// handler for a fixed list of files.

export const COI_HEADERS = {
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Embedder-Policy": "require-corp",
	"Cross-Origin-Resource-Policy": "same-origin"
} as const

export function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex")
}

// A parsed manifest value's own fields, or none when it is not a plain object.
export function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
}

export interface PinnedFile {
	readonly file: string
	readonly bytes: number
	readonly sha256: string
}

// Fails the build when a file's bytes are not the size and SHA-256 its manifest.json pins.
export function verifyPinned(context: { error: (message: string) => never }, source: Uint8Array, pin: PinnedFile): void {
	const digest = sha256(source)

	if (digest !== pin.sha256 || source.byteLength !== pin.bytes) {
		context.error(
			`${pin.file} is ${String(source.byteLength)} bytes with SHA-256 ${digest}; manifest.json says ${String(pin.bytes)} bytes, ${pin.sha256}`
		)
	}
}

// Serves exactly the `served` paths under `base` from `dir`, so it needs no path containment of its own. A listed
// file missing on disk answers 404. The preview serves the build's copies from dist/ instead, under the preview header
// set.
export function serveListedFiles(
	server: ViteDevServer,
	options: { readonly base: string; readonly dir: string; readonly served: ReadonlySet<string>; readonly mime: (rel: string) => string }
): void {
	const { base, dir, served, mime } = options

	server.middlewares.use((req, res, next) => {
		const path = (req.url ?? "").split("?")[0] ?? ""
		const rel = path.startsWith(base) ? path.slice(base.length) : null

		if (rel === null || !served.has(rel)) {
			next()

			return
		}

		const file = join(dir, rel)

		stat(file, (error, stats) => {
			if (error !== null || !stats.isFile()) {
				res.statusCode = 404
				res.end()

				return
			}

			res.setHeader("Content-Type", mime(rel))
			res.setHeader("Content-Length", stats.size)

			for (const [name, value] of Object.entries(COI_HEADERS)) {
				res.setHeader(name, value)
			}

			createReadStream(file)
				.on("error", () => {
					res.statusCode = 500
					res.end()
				})
				.pipe(res)
		})
	})
}
