import fs from "fs"
import path from "path"

const home = process.env.HOME || ""

const targets: [label: string, targetPath: string][] = [
	["Xcode Derived Data", path.join(home, "Library", "Developer", "Xcode", "DerivedData")],
	["Expo data", path.join(__dirname, ".expo")],
	["Gradle cache", path.join(home, ".gradle")]
]

for (const [label, targetPath] of targets) {
	if (fs.existsSync(targetPath)) {
		console.log(`Cleaning ${label} at:`, targetPath)

		fs.rmSync(targetPath, {
			recursive: true,
			force: true
		})

		console.log(`${label} cleaned successfully.`)
	}
}
