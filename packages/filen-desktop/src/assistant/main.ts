import { net } from "electron"
import { createSHA256 } from "hash-wasm"
import { getLlama, getLlamaGpuTypes, LlamaLogLevel } from "node-llama-cpp"
import type { ToEngine } from "../shared/assistantProtocol.ts"
import { createEngine } from "./engine.ts"

// The "Filen Assistant" utility process's entry. Requests go through Chromium's network stack (net.fetch), so the
// model download takes the system's proxy as the page's requests do. Offline, it checks Chromium's online state once a
// second, as the process gets no online event.
const port = process.parentPort

const engine = createEngine({
	send: message => {
		port.postMessage(message)
	},
	fetchShard: (url, init) => net.fetch(url, init),
	createHasher: createSHA256,
	connectivity: {
		isOnline: () => net.isOnline(),
		waitOnline: signal =>
			new Promise((resolve, reject) => {
				const timer = setInterval(() => {
					if (net.isOnline()) {
						clearInterval(timer)
						resolve()
					}
				}, 1000)

				signal.addEventListener(
					"abort",
					() => {
						clearInterval(timer)
						reject(signal.reason as Error)
					},
					{ once: true }
				)
			})
	},
	// Imported with the engine: a dynamic import of it beside the static ones never settles in esbuild's bundle.
	llama: () => Promise.resolve({ getLlama, getLlamaGpuTypes, LlamaLogLevel })
})

port.on("message", ({ data }: { data: ToEngine }) => {
	engine.handle(data)
})
