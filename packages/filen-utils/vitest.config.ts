import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
	resolve: {
		alias: {
			"@filen/utils": path.resolve(__dirname, "./src/index.ts")
		}
	}
})
