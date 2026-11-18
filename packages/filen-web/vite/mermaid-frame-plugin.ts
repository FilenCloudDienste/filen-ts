import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { build, type Plugin, type Rolldown } from "vite"
import { COI_HEADERS } from "./sdk-artifacts-plugin"

// The diagram frame's script (src/mermaidFrame/entry.ts): mermaid and the frame's host, built as ONE classic script of
// its own, so mermaid never enters the page's bundle. A build emits it at /assets/mermaid-frame-<hash>.js (the first 8
// hex digits of its SHA-256, immutable); the dev server builds it on its first request. `virtual:mermaid-frame` gives
// the page its path.
//
// The frame is sandboxed without allow-same-origin, so its origin is opaque and its script load is cross-origin; under
// the page's require-corp embedder policy that load needs this one asset to allow cross-origin embedding. Only this
// path gets the header.
export const MERMAID_FRAME_ASSET_GLOB = "/assets/mermaid-frame-*.js"
export const MERMAID_FRAME_ASSET_PATTERN = /^\/assets\/mermaid-frame-[0-9a-f]{8}\.js$/
export const MERMAID_FRAME_HEADERS = { "Cross-Origin-Resource-Policy": "cross-origin" } as const

const DEV_URL = "/assets/mermaid-frame-dev.js"
const VIRTUAL_ID = "virtual:mermaid-frame"
const RESOLVED_ID = `\0${VIRTUAL_ID}`
const ENTRY = fileURLToPath(new URL("../src/mermaidFrame/entry.ts", import.meta.url))
const SOURCE_ROOT = fileURLToPath(new URL("../src", import.meta.url))
// The frame fixes the dagre layout, so mermaid's ELK loader is never called: elkjs is replaced, not shipped.
const ELK_STUB = fileURLToPath(new URL("../src/mermaidFrame/elkStub.ts", import.meta.url))

async function buildFrameScript(): Promise<string> {
	const result = await build({
		configFile: false,
		logLevel: "warn",
		resolve: {
			alias: [
				{ find: /^elkjs\/lib\/elk\.bundled\.js$/, replacement: ELK_STUB },
				{ find: "@", replacement: SOURCE_ROOT }
			]
		},
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
		build: {
			write: false,
			minify: "oxc",
			copyPublicDir: false,
			reportCompressedSize: false,
			lib: { entry: ENTRY, name: "filenMermaidFrame", formats: ["iife"], fileName: () => "mermaid-frame.js" },
			// One file: a classic script cannot load chunks, and the frame's policy admits this script alone.
			rolldownOptions: { output: { codeSplitting: false, comments: { annotation: false } } }
		}
	})
	const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[]
	const chunks = outputs.flatMap(output => output.output).filter(item => item.type === "chunk")

	if (chunks.length !== 1 || chunks[0] === undefined) {
		throw new Error(`mermaid-frame: expected one script, got ${String(chunks.length)}`)
	}

	return chunks[0].code
}

export function mermaidFrameAsset(): Plugin {
	let isBuild = false
	let scriptUrl = DEV_URL
	let script: Promise<string> | undefined
	const ensureScript = (): Promise<string> => (script ??= buildFrameScript())

	return {
		name: "filen:mermaid-frame",
		configResolved(config) {
			isBuild = config.command === "build"
		},
		async buildStart() {
			if (!isBuild) {
				return
			}

			const code = await ensureScript()

			scriptUrl = `/assets/mermaid-frame-${createHash("sha256").update(code).digest("hex").slice(0, 8)}.js`
		},
		resolveId(id) {
			return id === VIRTUAL_ID ? RESOLVED_ID : null
		},
		load(id) {
			return id === RESOLVED_ID ? `export const MERMAID_FRAME_SCRIPT = ${JSON.stringify(scriptUrl)}\n` : null
		},
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				if ((req.url ?? "").split("?")[0] !== DEV_URL) {
					next()

					return
				}

				ensureScript().then(
					code => {
						res.setHeader("Content-Type", "text/javascript")

						for (const [name, value] of Object.entries({ ...COI_HEADERS, ...MERMAID_FRAME_HEADERS })) {
							res.setHeader(name, value)
						}

						res.end(code)
					},
					(error: unknown) => {
						server.config.logger.error(`mermaid-frame: ${error instanceof Error ? error.message : String(error)}`)
						res.statusCode = 500
						res.end()
					}
				)
			})
		},
		async generateBundle() {
			this.emitFile({ type: "asset", fileName: scriptUrl.slice(1), source: await ensureScript() })
		}
	}
}
