import { buildWasm } from "../../scripts/build-wasm.mjs"

// The tests run the real module: build it first (incremental, so a no-op when nothing changed).
export default async function setup(): Promise<void> {
	await buildWasm()
}
