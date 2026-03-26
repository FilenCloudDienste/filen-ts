import NetInfo from "@react-native-community/netinfo"
import QuickCrypto, { Buffer } from "react-native-quick-crypto"
import { NETINFO_CONFIG } from "@/constants"
import { enableFreeze } from "react-native-screens"

enableFreeze(true)

globalThis.crypto = {
	...globalThis.crypto,
	// This is fine
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	getRandomValues: QuickCrypto.getRandomValues as unknown as any
}

// @ts-expect-error This is fine
globalThis.Buffer = Buffer

NetInfo.configure(NETINFO_CONFIG)
