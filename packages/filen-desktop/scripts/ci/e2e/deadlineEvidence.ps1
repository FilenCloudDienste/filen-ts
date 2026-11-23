# The machine as a deep chain's harness left it at the step deadline (scripts/ci/deepSession.sh): every process with
# its CPU time, memory and threads, the services caught starting or stopping, the volumes, memory and file system
# drives, and the screen. No command lines (they can carry a secret). Each part is written even when another fails.
param([Parameter(Mandatory = $true)][string]$Prefix)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

try {
	Get-CimInstance Win32_Process | Sort-Object ProcessId | ForEach-Object {
		"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CreationDate)`t$([math]::Round(($_.KernelModeTime + $_.UserModeTime) / 1e7))s`t$([math]::Round($_.WorkingSetSize / 1MB))MB`t$($_.ThreadCount)`t$($_.Name)`t$($_.ExecutablePath)"
	} | Out-File -Encoding utf8 "$Prefix-processes.txt"
	Get-Service | Where-Object { $_.Status -notin 'Running', 'Stopped' } | ForEach-Object { "service $($_.Name) $($_.Status)" } |
		Out-File -Encoding utf8 -Append "$Prefix-processes.txt"
} catch {
	"processes: $_" | Out-File -Encoding utf8 -Append "$Prefix-errors.txt"
}

try {
	Get-CimInstance Win32_Volume | Format-List DriveLetter, Label, FileSystem, Capacity, FreeSpace | Out-File -Encoding utf8 "$Prefix-machine.txt"
	Get-CimInstance Win32_OperatingSystem | Format-List FreePhysicalMemory, FreeVirtualMemory, TotalVisibleMemorySize |
		Out-File -Encoding utf8 -Append "$Prefix-machine.txt"
	Get-PSDrive -PSProvider FileSystem | Format-Table -AutoSize | Out-File -Encoding utf8 -Append "$Prefix-machine.txt"
} catch {
	"machine: $_" | Out-File -Encoding utf8 -Append "$Prefix-errors.txt"
}

try {
	Add-Type -AssemblyName System.Windows.Forms, System.Drawing
	$area = [System.Windows.Forms.SystemInformation]::VirtualScreen
	$bitmap = New-Object System.Drawing.Bitmap $area.Width, $area.Height
	[System.Drawing.Graphics]::FromImage($bitmap).CopyFromScreen($area.Left, $area.Top, 0, 0, $bitmap.Size)
	$bitmap.Save("$Prefix-screen.png", [System.Drawing.Imaging.ImageFormat]::Png)
} catch {
	"screen: $_" | Out-File -Encoding utf8 -Append "$Prefix-errors.txt"
}
