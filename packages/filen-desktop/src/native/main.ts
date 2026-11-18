import { startHost } from "./index.ts"

// The native host's entry (dist/native.js): the utility process's port to main, and its exit.
startHost(process.parentPort, code => {
	process.exit(code)
})
