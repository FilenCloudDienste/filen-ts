// The last 3.x release, which every installed client runs before it updates to 4.x. Its installers come from the old
// repository's GitHub release (the same files cdn.filen.io served as the 3.0.53 feed); the sha512 values are copied
// from that release's latest*.yml, so a replaced or corrupted download fails instead of being tested.
//
// 3.0.53 carries its own CI hook (filen-desktop src/lib/updater.ts): FILEN_E2E_UPDATER=1 with a loopback
// FILEN_E2E_UPDATE_FEED makes it check that feed right after start and install a downloaded update without the user's
// click, once per FILEN_E2E_ONCE_FILE. Its log is <appData>/@filen/logs/desktop.log.

export const LEGACY_VERSION = "3.0.53"
export const LEGACY_RELEASE_URL = "https://github.com/FilenCloudDienste/filen-desktop/releases/download/v3.0.53/"
export const LEGACY_E2E_BANNER = "Updater E2E mode enabled"

export const LEGACY_SHA512: Readonly<Record<string, string>> = {
	"Filen_win.exe": "5ze1QM+l9QGKd2T6liM31PDKtXkmhp2OKifK+gelWpnnAoa6470mzhKk0/ldL8fkhBTMVjY13JoNObQrovejqg==",
	"Filen_mac_x64.dmg": "3EXv/+dPxWx+UcN1meCvE+cgvWFYRXCOdeBRrJOYQwI9/y0mrY2xFJkA22lea3M12L3DACkAYevp4w10uJxujg==",
	"Filen_mac_arm64.dmg": "gsi6ZSs6WuZA5jBadrXkB9QaIgTIA0KX9nPxYbZ9skKTpCG+MZHvpJC5gp4kd1TPEFRQRq1cWwZ6NK77fyremw==",
	"Filen_linux_x86_64.AppImage": "eAATu6IpTjNVUBkjDjxTI7GV+Km5XtJGz3pzGq9ZyVx/r6whwWG1iLXgMc+fMV0hdat9ugnib/QPwAkMTTETrA==",
	"Filen_linux_arm64.AppImage": "yP+941V+NN8+M2Y+r3m/Elj5cf6anf/qVaTM9YXRhe/1m/Ja4SsYIIGBkqYys41eSMvuup+BJItVOFl0cqPmxA==",
	"Filen_linux_amd64.deb": "8ONvTj+wSKWpEsOipgq+txwXR1rsNeaMRYGCCi4av5vOB2AcCQ69DUjbLIeHyExvNlTtXmbrS4VTA0TRzWJClA==",
	"Filen_linux_arm64.deb": "PYH8L3uKpzg6iX2bF/hv/8au5PpWIYWkoTlXx0K2q9oo0zwyY5io3pGPA4aQ3PZyRoKqG1pcXDBXD67Yl09tPA==",
	"Filen_linux_x86_64.rpm": "6/8jHYz1rhbhU+6npysJVIlda4Szuu3Yr3hJT8hlX9r4vrOTZ1wSTb239vLduIhST9nIFfNrXUuhcabKyT2/qg==",
	"Filen_linux_aarch64.rpm": "R9LhkuWZnEuvJOTgIODyKVbM9+awkVBokTrfgMkMIN92vhNDZUSqLqCwUhs8Jd1Rn8xbbryGh0xvmc8eh2c2Cw=="
}
