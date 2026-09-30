import fs from "fs"
import path from "path"

// --deep also wipes the machine-wide Xcode and Gradle caches (superclean)
const deep = process.argv.includes("--deep")
const home = process.env.HOME || ""
const expoData: [label: string, targetPath: string] = ["Expo data", path.join(__dirname, ".expo")]

const targets: [label: string, targetPath: string][] = deep
	? [
			["Xcode Derived Data", path.join(home, "Library", "Developer", "Xcode", "DerivedData")],
			expoData,
			["Gradle cache", path.join(home, ".gradle")]
		]
	: [expoData]

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
