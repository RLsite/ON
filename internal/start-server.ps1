# Starts the QA dashboard server only (no browser). Never needs admin rights.
$existing = Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Server is already running on port 8790." -ForegroundColor Yellow
} else {
    Start-Process -FilePath "C:\Program Files\nodejs\node.exe" `
      -ArgumentList '"C:\harel\RLAPP ON RL\QA\assets\server.js"' `
      -WindowStyle Hidden
    Start-Sleep -Seconds 2
    Write-Host "Server started." -ForegroundColor Green
}
Start-Sleep -Seconds 2
