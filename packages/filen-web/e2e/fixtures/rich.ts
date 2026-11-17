import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"
import { scenarioModule } from "./scenarios"

// The rich viewers' files (preview-rich.spec.ts): fonts from the office package's own assets.

const FONTS = fileURLToPath(new URL("../../../filen-office/assets/fonts/arimo/", import.meta.url))

export const RICH_FONT_FAMILY = "Arimo"

export const RICH_SCENARIOS = scenarioModule(
	{
		"rich-fonts": ["rich-font.ttf", "rich-webfont.woff2"]
	},
	() => ({
		"rich-font.ttf": { generate: () => gunzipSync(readFileSync(`${FONTS}Arimo-Regular.ttf.gz`)) },
		// A variable face: its weight axis gets a slider.
		"rich-webfont.woff2": { buffer: readFileSync(`${FONTS}Arimo-VF.woff2`), mimeType: "font/woff2" }
	})
)
