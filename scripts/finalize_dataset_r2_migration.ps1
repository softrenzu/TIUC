$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$bucket = 'tiuc-photos'
$db = 'tiuc-db'
$datasetRoot = Join-Path $repoRoot 'dataset'
$wrangler = Join-Path $repoRoot 'node_modules\.bin\wrangler.cmd'

if (!(Test-Path $datasetRoot)) { throw "dataset folder not found: $datasetRoot" }
if (!(Test-Path $wrangler)) { throw "Wrangler not found. Run npm install first." }
if ([string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)) { throw "CLOUDFLARE_API_TOKEN is not set." }

$files = @(Get-ChildItem $datasetRoot -Recurse -File | Where-Object { $_.Extension.ToLowerInvariant() -in @('.jpg','.jpeg','.png','.webp') })
$fileCount = [int]$files.Count
if ($fileCount -ne 1000) { throw "Expected exactly 1000 images, found $fileCount." }

function Get-GroupCode([string]$relativePath) {
    $first = ($relativePath -split '/')[0]
    if ($first.StartsWith('01_')) { return '01' }
    if ($first.StartsWith('02_')) { return '02' }
    throw "Unknown dataset group: $first"
}

function Get-R2Key($file) {
    $rel = $file.FullName.Substring($datasetRoot.Length + 1).Replace('\','/')
    $groupCode = Get-GroupCode $rel
    return "dataset/$groupCode/$($file.Name)"
}

Write-Host "Step 1/4: verify R2 sample objects" -ForegroundColor Cyan
$middleIndex = [int][Math]::Floor($fileCount / 2)
$lastIndex = [int]($fileCount - 1)
$sampleIndexes = @(0, $middleIndex, $lastIndex)
foreach ($idx in $sampleIndexes) {
    $f = $files[[int]$idx]
    $key = Get-R2Key $f
    $tmp = Join-Path $env:TEMP ("tiuc_r2_verify_" + [Guid]::NewGuid().ToString('N') + $f.Extension)
    & $wrangler r2 object get "$bucket/$key" --file="$tmp" --remote
    if ($LASTEXITCODE -ne 0) { throw "R2 sample download failed: $key" }
    $localHash = (Get-FileHash -Algorithm SHA256 $f.FullName).Hash
    $r2Hash = (Get-FileHash -Algorithm SHA256 $tmp).Hash
    Remove-Item $tmp -Force
    if ($localHash -ne $r2Hash) { throw "R2 sample hash mismatch: $key" }
    Write-Host "verified: $key" -ForegroundColor Green
}

Write-Host "Step 2/4: update D1 r2_key values in chunks" -ForegroundColor Cyan
$chunkSize = 100
for ($start = 0; $start -lt $fileCount; $start += $chunkSize) {
    $endExclusive = [Math]::Min($start + $chunkSize, $fileCount)
    $sqlLines = New-Object 'System.Collections.Generic.List[string]'

    for ($i = $start; $i -lt $endExclusive; $i++) {
        $f = $files[$i]
        $rel = $f.FullName.Substring($datasetRoot.Length + 1).Replace('\','/')
        $repoPath = "dataset/$rel"
        $key = Get-R2Key $f
        $repoSql = $repoPath.Replace("'", "''")
        $keySql = $key.Replace("'", "''")
        $sqlLines.Add("UPDATE dataset_images SET r2_key='$keySql' WHERE repo_path='$repoSql';")
    }

    $chunkNo = [int]([Math]::Floor($start / $chunkSize) + 1)
    $sqlPath = Join-Path $env:TEMP ("tiuc_dataset_r2_keys_chunk_" + $chunkNo + ".sql")
    [System.IO.File]::WriteAllLines($sqlPath, $sqlLines, (New-Object System.Text.UTF8Encoding($false)))

    & $wrangler d1 execute $db --remote --file="$sqlPath" --yes
    if ($LASTEXITCODE -ne 0) { throw "D1 r2_key update failed in chunk $chunkNo. GitHub dataset will NOT be deleted." }
    Write-Host "D1 chunk $chunkNo / 10 updated" -ForegroundColor Green
}

$verifyRaw = & $wrangler d1 execute $db --remote --json --command "SELECT COUNT(*) AS total, SUM(CASE WHEN r2_key IS NOT NULL AND length(r2_key) > 0 THEN 1 ELSE 0 END) AS r2_count FROM dataset_images;"
if ($LASTEXITCODE -ne 0) { throw "D1 verification failed. GitHub dataset will NOT be deleted." }
$verify = $verifyRaw | ConvertFrom-Json
if ($verify -is [System.Array]) { $row = $verify[0].results[0] } else { $row = $verify.results[0] }
if ([int]$row.total -ne 1000 -or [int]$row.r2_count -ne 1000) {
    throw "D1 verification mismatch: total=$($row.total), r2_count=$($row.r2_count). GitHub dataset will NOT be deleted."
}
Write-Host "D1 verified: 1000 / 1000 rows have r2_key" -ForegroundColor Green

Write-Host "Step 3/4: record migration 0010" -ForegroundColor Cyan
& $wrangler d1 migrations apply $db --remote --yes
if ($LASTEXITCODE -ne 0) { throw "Migration bookkeeping failed. GitHub dataset will NOT be deleted." }

Write-Host "Step 4/4: remove dataset from GitHub working tree and push" -ForegroundColor Cyan
& git rm -r dataset
if ($LASTEXITCODE -ne 0) { throw "git rm failed." }

& git commit -m 'Move image dataset from GitHub to Cloudflare R2' -- dataset
if ($LASTEXITCODE -ne 0) { throw "git commit failed." }

& git push origin main
if ($LASTEXITCODE -ne 0) { throw "git push failed. The deletion commit exists locally; retry git push origin main." }

Write-Host "DONE: R2 verified, D1 updated, and dataset removed from GitHub main." -ForegroundColor Green
Write-Host "Note: old Git history still contains the image blobs." -ForegroundColor Yellow
