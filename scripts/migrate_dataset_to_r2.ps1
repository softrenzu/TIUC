$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$bucket = 'tiuc-photos'
$db = 'tiuc-db'
$datasetRoot = Join-Path $repoRoot 'dataset'
$wrangler = Join-Path $repoRoot 'node_modules\.bin\wrangler.cmd'

if (!(Test-Path $datasetRoot)) { throw "dataset folder not found: $datasetRoot" }
if (!(Test-Path $wrangler)) { throw 'Wrangler not found. Run npm install first.' }
if ([string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)) { throw 'CLOUDFLARE_API_TOKEN is not set.' }

$files = @(Get-ChildItem $datasetRoot -Recurse -File | Where-Object { $_.Extension.ToLowerInvariant() -in @('.jpg','.jpeg','.png','.webp') } | Sort-Object FullName)
if ($files.Count -ne 1000) { throw "Safety stop: expected 1000 image files, found $($files.Count)." }

Write-Host 'Starting R2 migration for 1000 images. Git deletion happens only after verification.' -ForegroundColor Cyan

$sqlLines = New-Object 'System.Collections.Generic.List[string]'
$sqlLines.Add('BEGIN;')
$uploaded = New-Object 'System.Collections.Generic.List[object]'
$i = 0

foreach ($f in $files) {
    $rel = $f.FullName.Substring($datasetRoot.Length + 1).Replace('\','/')
    if ($rel.StartsWith('01_')) { $groupCode = '01' }
    elseif ($rel.StartsWith('02_')) { $groupCode = '02' }
    else { throw "Unknown dataset group: $rel" }

    $key = "dataset/$groupCode/$($f.Name)"
    switch ($f.Extension.ToLowerInvariant()) {
        '.jpg'  { $contentType = 'image/jpeg' }
        '.jpeg' { $contentType = 'image/jpeg' }
        '.png'  { $contentType = 'image/png' }
        '.webp' { $contentType = 'image/webp' }
        default { throw "Unsupported file type: $($f.FullName)" }
    }

    & $wrangler r2 object put "$bucket/$key" --file="$($f.FullName)" --content-type="$contentType" --remote --force
    if ($LASTEXITCODE -ne 0) { throw "R2 upload failed: $($f.FullName)" }

    $repoPath = "dataset/$rel"
    $repoSql = $repoPath.Replace("'", "''")
    $keySql = $key.Replace("'", "''")
    $sqlLines.Add("UPDATE dataset_images SET r2_key='$keySql' WHERE repo_path='$repoSql';")
    $uploaded.Add([pscustomobject]@{ File=$f.FullName; Key=$key })

    $i++
    if (($i % 50) -eq 0) { Write-Host "$i / 1000 uploaded" -ForegroundColor Green }
}

$sqlLines.Add('COMMIT;')
$sqlPath = Join-Path $env:TEMP 'tiuc_dataset_r2_keys.sql'
[System.IO.File]::WriteAllLines($sqlPath, $sqlLines, (New-Object System.Text.UTF8Encoding($false)))

& $wrangler d1 execute $db --remote --file="$sqlPath" --yes
if ($LASTEXITCODE -ne 0) { throw 'D1 r2_key update failed. GitHub dataset will NOT be deleted.' }

$verifySql = "SELECT COUNT(*) AS total, SUM(CASE WHEN r2_key IS NOT NULL AND length(r2_key) > 0 THEN 1 ELSE 0 END) AS r2_count FROM dataset_images;"
$verifyRaw = & $wrangler d1 execute $db --remote --json --command $verifySql
if ($LASTEXITCODE -ne 0) { throw 'D1 verification failed. GitHub dataset will NOT be deleted.' }
$verify = $verifyRaw | ConvertFrom-Json
if ($verify -is [System.Array]) { $row = $verify[0].results[0] } else { $row = $verify.results[0] }
if ([int]$row.total -ne 1000 -or [int]$row.r2_count -ne 1000) {
    throw "D1 verification mismatch: total=$($row.total), r2_count=$($row.r2_count). GitHub dataset will NOT be deleted."
}

$sampleIndexes = @(0, [int][Math]::Floor($uploaded.Count / 2), $uploaded.Count - 1)
foreach ($idx in $sampleIndexes) {
    $s = $uploaded[$idx]
    $tmp = Join-Path $env:TEMP ("tiuc_r2_verify_" + [Guid]::NewGuid().ToString('N') + [IO.Path]::GetExtension($s.File))
    & $wrangler r2 object get "$bucket/$($s.Key)" --file="$tmp" --remote
    if ($LASTEXITCODE -ne 0) { throw "R2 verification download failed: $($s.Key)" }
    $localHash = (Get-FileHash -Algorithm SHA256 $s.File).Hash
    $r2Hash = (Get-FileHash -Algorithm SHA256 $tmp).Hash
    Remove-Item $tmp -Force
    if ($localHash -ne $r2Hash) { throw "R2 SHA256 mismatch: $($s.Key)" }
}

Write-Host 'Verification OK: R2 uploads, D1 keys, and SHA256 samples.' -ForegroundColor Green

& $wrangler d1 migrations apply $db --remote --yes
if ($LASTEXITCODE -ne 0) { throw 'D1 migrations apply failed. GitHub dataset will NOT be deleted.' }

$origin = (& git remote get-url origin).Trim()
Write-Host "Git origin: $origin"

& git rm -r dataset
if ($LASTEXITCODE -ne 0) { throw 'git rm failed.' }

& git commit -m 'Move image dataset from GitHub to Cloudflare R2' -- dataset
if ($LASTEXITCODE -ne 0) { throw 'git commit failed.' }

& git push origin main
if ($LASTEXITCODE -ne 0) { throw 'git push failed. The local deletion commit exists; retry git push origin main.' }

Write-Host 'DONE: 1000 images moved to R2, D1 updated, and dataset removed from GitHub main.' -ForegroundColor Cyan
Write-Host 'Note: old Git history still contains image blobs. History rewrite is separate.' -ForegroundColor Yellow
