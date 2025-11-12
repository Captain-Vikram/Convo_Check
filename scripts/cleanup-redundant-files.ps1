# Cleanup Redundant Files Script
# Generated after alert migration completion

Write-Host "🧹 Starting file cleanup..." -ForegroundColor Cyan

$projectRoot = "c:\Users\konth\Desktop\project\MH\Convo_Check"
$deletedFiles = @()
$reviewFiles = @()

# Files to DELETE (redundant/failed)
$filesToDelete = @(
    "scripts\create-alerts-table.ps1",
    "scripts\pull-alerts-schema.ps1",
    "docs\ALERTS_TABLE_SCHEMA.sql"
)

# Files to REVIEW (legacy data)
$filesToReview = @(
    "data\alerts.json",
    "data\habits.csv",
    "data\coach-briefings.json"
)

Write-Host "`n📋 Files marked for deletion:" -ForegroundColor Yellow
foreach ($file in $filesToDelete) {
    $fullPath = Join-Path $projectRoot $file
    if (Test-Path $fullPath) {
        Write-Host "  ❌ $file" -ForegroundColor Red
    }
    else {
        Write-Host "  ⚠️  $file (not found)" -ForegroundColor DarkGray
    }
}

Write-Host "`n📋 Files to review (legacy data):" -ForegroundColor Yellow
foreach ($file in $filesToReview) {
    $fullPath = Join-Path $projectRoot $file
    if (Test-Path $fullPath) {
        $size = (Get-Item $fullPath).Length
        Write-Host "  ⚠️  $file ($([math]::Round($size/1KB, 2)) KB)" -ForegroundColor Yellow
    }
    else {
        Write-Host "  ⚠️  $file (not found)" -ForegroundColor DarkGray
    }
}

# Ask for confirmation
Write-Host "`n⚠️  This will permanently delete redundant files." -ForegroundColor Red
$confirmation = Read-Host "Continue? (yes/no)"

if ($confirmation -ne "yes") {
    Write-Host "❌ Cleanup cancelled." -ForegroundColor Yellow
    exit 0
}

# Delete redundant files
Write-Host "`n🗑️  Deleting files..." -ForegroundColor Cyan
foreach ($file in $filesToDelete) {
    $fullPath = Join-Path $projectRoot $file
    if (Test-Path $fullPath) {
        try {
            Remove-Item $fullPath -Force
            Write-Host "  ✅ Deleted: $file" -ForegroundColor Green
            $deletedFiles += $file
        }
        catch {
            Write-Host "  ❌ Failed to delete: $file - $_" -ForegroundColor Red
        }
    }
}

# Check legacy data files
Write-Host "`n📊 Checking legacy data files..." -ForegroundColor Cyan

# Check alerts.json
$alertsJson = Join-Path $projectRoot "data\alerts.json"
if (Test-Path $alertsJson) {
    try {
        $content = Get-Content $alertsJson -Raw | ConvertFrom-Json
        $count = if ($content -is [Array]) { $content.Count } else { 1 }
        Write-Host "  📄 data\alerts.json: $count alerts" -ForegroundColor Yellow
        Write-Host "     → Check if these need migration to database" -ForegroundColor DarkYellow
    }
    catch {
        Write-Host "  ⚠️  data\alerts.json: Invalid JSON or empty" -ForegroundColor Yellow
    }
}

# Check habits.csv
$habitsCsv = Join-Path $projectRoot "data\habits.csv"
if (Test-Path $habitsCsv) {
    $lines = (Get-Content $habitsCsv | Measure-Object -Line).Lines
    Write-Host "  📄 data\habits.csv: $lines lines" -ForegroundColor Yellow
    Write-Host "     → Check if data migrated to habit_insights table" -ForegroundColor DarkYellow
}

# Check coach-briefings.json
$briefingsJson = Join-Path $projectRoot "data\coach-briefings.json"
if (Test-Path $briefingsJson) {
    try {
        $content = Get-Content $briefingsJson -Raw | ConvertFrom-Json
        $count = if ($content -is [Array]) { $content.Count } else { 1 }
        Write-Host "  📄 data\coach-briefings.json: $count briefings" -ForegroundColor Yellow
        Write-Host "     → Check if data migrated to coach_briefings table" -ForegroundColor DarkYellow
    }
    catch {
        Write-Host "  ⚠️  data\coach-briefings.json: Invalid JSON or empty" -ForegroundColor Yellow
    }
}

# Summary
Write-Host "`n✅ Cleanup Summary:" -ForegroundColor Green
Write-Host "  Deleted: $($deletedFiles.Count) files" -ForegroundColor White
if ($deletedFiles.Count -gt 0) {
    $deletedFiles | ForEach-Object { Write-Host "    - $_" -ForegroundColor DarkGray }
}

Write-Host "`n⚠️  Manual Review Required:" -ForegroundColor Yellow
Write-Host "  - Verify legacy data files before deletion" -ForegroundColor White
Write-Host "  - Compare with database records" -ForegroundColor White
Write-Host "  - Backup if needed before removing" -ForegroundColor White

Write-Host "`n🎉 Cleanup complete!" -ForegroundColor Green
