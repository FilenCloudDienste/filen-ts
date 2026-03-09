import NetInfo from "@react-native-community/netinfo"
import { Buffer } from "buffer"
import { NETINFO_CONFIG } from "@/constants"
import QuickCrypto from "react-native-quick-crypto"

globalThis.crypto = {
	...globalThis.crypto,
	// This is fine
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	getRandomValues: QuickCrypto.getRandomValues as unknown as any
}

globalThis.Buffer = Buffer

NetInfo.configure(NETINFO_CONFIG)
