$electron = 'F:\Work\Create\Assa\Xiyue\node_modules\electron\dist\electron.exe'
$workdir = 'F:\Work\Create\OCR\screenshot'
$cmd = '/c cd /d ' + $workdir + ' && "' + $electron + '" app > app\smart_out.log 2> app\smart_err.log'
Start-Process cmd -ArgumentList $cmd -WindowStyle Hidden
Write-Output "LAUNCHED"
