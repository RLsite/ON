# Stops the QA dashboard server. No admin rights needed for the normal case
# (a plain user-owned node process). If a "QADashboard" scheduled task was
# installed separately, this also tries to stop it (harmless if it doesn't exist).
Stop-ScheduledTask -TaskName "QADashboard" -ErrorAction SilentlyContinue

Write-Host "Stopping any process listening on port 8790..." -ForegroundColor Cyan
$c = Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue
if ($c) {
    $c.OwningProcess | Select-Object -Unique | ForEach-Object {
        Write-Host "  Killing PID $_"
        Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "  No process currently listening on 8790."
}

Write-Host ""
Write-Host "QA dashboard server stopped." -ForegroundColor Green
Read-Host "Press Enter to close"
