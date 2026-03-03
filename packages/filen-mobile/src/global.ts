import NetInfo from "@react-native-community/netinfo"
import { Buffer } from "buffer"
import { NETINFO_CONFIG } from "@/constants"
import QuickCrypto from "react-native-quick-crypto"

globalThis.crypto = {
	...globalThis.crypto,
	getRandomValues: QuickCrypto.getRandomValues
}

globalThis.Buffer = Buffer

NetInfo.configure(NETINFO_CONFIG)
