import { withAndroidManifest, withDangerousMod, AndroidConfig, type ConfigPlugin } from "expo/config-plugins"
import fs from "node:fs"
import path from "node:path"
import { buildNetworkSecurityConfig, extractAarNetworkSecurityConfig, loadRustlsPlatformVerifierAar } from "./rustlsPlatformVerifier"

const isDevelopment = process.env["APP_ENV"] === "development" || process.env["NODE_ENV"] === "development"

const DEV_HOSTS = [
	"192.168.178.39",
	"192.168.178.51",
	"192.168.178.79",
	"192.168.178.82",
	"192.168.178.107",
	"192.168.100.124",
	"192.168.100.162",
	"192.168.100.110",
	"192.168.0.94",
	"192.168.178.103",
	"10.0.2.2",
	"192.168.178.80",
	"192.168.0.15",
	"192.168.0.152"
]

export const CLEARTEXT_HOSTS = ["127.0.0.1", ...(isDevelopment ? DEV_HOSTS : [])]

// Generated from the pinned rustls-platform-verifier AAR on every prebuild, never hand-copied. The
// network check for Filen's live CRL hosts is scripts/checkCrlHosts.ts (pnpm run check:crl-hosts).
export async function generateNetworkSecurityConfig(projectRoot: string): Promise<string> {
	const aar = await loadRustlsPlatformVerifierAar(projectRoot)

	return buildNetworkSecurityConfig({
		appCleartextHosts: CLEARTEXT_HOSTS,
		aarNetworkSecurityConfig: await extractAarNetworkSecurityConfig(aar)
	})
}

function setNetworkSecurityConfig(
	androidManifest: AndroidConfig.Manifest.AndroidManifest
): AndroidConfig.Manifest.AndroidManifest {
	const application = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest)

	application.$["android:networkSecurityConfig"] = "@xml/network_security_config"

	return androidManifest
}

const withAndroidNetworkSecurityConfig: ConfigPlugin = config => {
	config = withAndroidManifest(config, async config => {
		config.modResults = setNetworkSecurityConfig(config.modResults)

		return config
	})

	return withDangerousMod(config, [
		"android",
		async config => {
			const networkSecurityConfigPath = path.join(
				config.modRequest.platformProjectRoot,
				"app/src/main/res/xml/network_security_config.xml"
			)

			fs.mkdirSync(path.dirname(networkSecurityConfigPath), {
				recursive: true
			})

			fs.writeFileSync(networkSecurityConfigPath, await generateNetworkSecurityConfig(config.modRequest.projectRoot))

			return config
		}
	])
}

export default withAndroidNetworkSecurityConfig
