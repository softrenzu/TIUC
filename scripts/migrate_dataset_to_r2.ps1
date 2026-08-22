$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$bucket = 'tiuc-photos'
$db = 'tiuc-db'
$datasetRoot = Join-Path $repoRoot 'dataset'
$wrangler = Join-Path $repoRoot 'node_modules\.bin\wrangler.cmd'

if (!(Test-Path $datasetRoot)) { throw "dataset フォルダがありません: $datasetRoot" }
if (!(Test-Path $wrangler)) { throw "Wrangler がありません。先に npm install を実行してください。" }
if ([string]::IsNullOrWhiteSpace($env:CLOUDFLARE_API_TOKEN)) { throw "CLOUDFLARE_API_TOKEN が設定されていません。" }

$files = @(Get-ChildItem $datasetRoot -Recurse -File | Where-Object { $_.Extension.ToLowerInvariant() -in @('.jpg','.jpeg','.png','.webp') })
if ($files.Count -ne 1000) { throw "安全のため停止しました。画像数が1000ではありません: $($files.Count)" }

Write-Host "R2へ1000枚を移行します。GitHub削除は全検証成功後だけ行います。" -ForegroundColor Cyan

$sqlLines = New-Object 'System.Collections.Generic.List[string]'
$sqlLines.Add('BEGIN;')
$uploaded = New-Object 'System.Collections.Generic.List[object]'
$i = 0

foreach ($f in $files) {
    $rel = $f.FullName.Substring($datasetRoot.Length + 1).Replace('\','/')
    if ($rel.StartsWith('01_誤訳不自然表記/')) { $groupCode = '01' }
    elseif ($rel.StartsWith('02_日本の多言語看板_要確認/')) { $groupCode = '02' }
    else { throw "未知のdatasetグループです: $rel" }

    $key = "dataset/$groupCode/$($f.Name)"
    switch ($f.Extension.ToLowerInvariant()) {
        '.jpg'  { $contentType = 'image/jpeg' }
        '.jpeg' { $contentType = 'image/jpeg' }
        '.png'  { $contentType = 'image/png' }
        '.webp' { $contentType = 'image/webp' }
        default { throw "未対応形式: $($f.FullName)" }
    }

    & $wrangler r2 object put "$bucket/$key" --file="$($f.FullName)" --content-type="$contentType" --remote --force
    if ($LASTEXITCODE -ne 0) { throw "R2アップロード失敗: $($f.FullName)" }

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
if ($LASTEXITCODE -ne 0) { throw 'D1 r2_key 更新に失敗しました。GitHubは削除しません。' }

$verifyRaw = & $wrangler d1 execute $db --remote --json --command "SELECT COUNT(*) AS total, SUM(CASE WHEN r2_key IS NOT NULL AND r2_key <> '' THEN 1 ELSE 0 END) AS r2_count FROM dataset_images;"
if ($LASTEXITCODE -ne 0) { throw 'D1検証に失敗しました。GitHubは削除しません。' }
$verify = $verifyRaw | ConvertFrom-Json
if ($verify -is [System.Array]) { $row = $verify[0].results[0] } else { $row = $verify.results[0] }
if ([int]$row.total -ne 1000 -or [int]$row.r2_count -ne 1000) {
    throw "D1検証不一致 total=$($row.total) r2_count=$($row.r2_count)。GitHubは削除しません。"
}

# R2実体を先頭・中央・末尾の3件でダウンロード照合
$sampleIndexes = @(0, [int][Math]::Floor($uploaded.Count / 2), $uploaded.Count - 1)
foreach ($idx in $sampleIndexes) {
    $s = $uploaded[$idx]
    $tmp = Join-Path $env:TEMP ("tiuc_r2_verify_" + [Guid]::NewGuid().ToString('N') + [IO.Path]::GetExtension($s.File))
    & $wrangler r2 object get "$bucket/$($s.Key)" --file="$tmp" --remote
    if ($LASTEXITCODE -ne 0) { throw "R2検証ダウンロード失敗: $($s.Key)" }
    $localHash = (Get-FileHash -Algorithm SHA256 $s.File).Hash
    $r2Hash = (Get-FileHash -Algorithm SHA256 $tmp).Hash
    Remove-Item $tmp -Force
    if ($localHash -ne $r2Hash) { throw "R2内容不一致: $($s.Key)" }
}

Write-Host 'R2 1000件 + D1 1000件 + サンプルSHA256検証 OK' -ForegroundColor Green

# migration 0010 を適用済みとして記録（CREATE IF NOT EXISTSなので既存テーブルでも安全）
& $wrangler d1 migrations apply $db --remote --yes
if ($LASTEXITCODE -ne 0) { throw 'migrations apply に失敗しました。GitHubは削除しません。' }

$origin = (& git remote get-url origin).Trim()
Write-Host "Git origin: $origin"

& git rm -r dataset
if ($LASTEXITCODE -ne 0) { throw 'git rm に失敗しました。' }

& git commit -m 'Move image dataset from GitHub to Cloudflare R2' -- dataset
if ($LASTEXITCODE -ne 0) { throw 'git commit に失敗しました。' }

& git push origin main
if ($LASTEXITCODE -ne 0) { throw 'git push に失敗しました。ローカルでは削除コミット済みなので push を再実行してください。' }

Write-Host '完了: R2へ移行、D1更新、GitHub main から dataset/ を削除しました。' -ForegroundColor Cyan
Write-Host '注意: GitHubの過去コミット履歴には画像blobが残ります。完全消去が必要なら履歴書き換えを別途実施してください。' -ForegroundColor Yellow
