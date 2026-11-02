$all = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'electron.exe' -or ($_.Name -match 'python' -and $_.CommandLine -match 'rapidocr|paddle')
}
foreach ($p in $all) {
    $cl = if ($p.CommandLine) { $p.CommandLine.Substring(0, [Math]::Min(150, $p.CommandLine.Length)) } else { '' }
    Write-Output ("PID=" + $p.ProcessId + " PPID=" + $p.ParentProcessId + " CREATED=" + $p.CreationDate.ToString('HH:mm:ss') + " :: " + $cl)
}
