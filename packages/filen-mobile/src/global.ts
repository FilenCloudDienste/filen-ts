import NetInfo from "@react-native-community/netinfo"
import crypto from "crypto"
import { Buffer } from "buffer"
import { NETINFO_CONFIG } from "@/constants"

globalThis.crypto = {
	...globalThis.crypto,
	getRandomValues: crypto.getRandomValues
}

globalThis.Buffer = Buffer

NetInfo.configure(NETINFO_CONFIG)
