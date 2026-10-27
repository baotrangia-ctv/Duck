param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('rules', 'chatflow', 'compass', 'auto')]
  [string]$Extractor,
  [string]$PublicOrigin = 'https://craftland-duck.demo.ved.com.vn',
  [ValidateRange(1, 65535)]
  [int]$Port = 3000,
  [string]$ConfigRoot = '',
  [string]$OutputZip = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
if (-not $ConfigRoot) { $ConfigRoot = $repoRoot }
$ConfigRoot = [System.IO.Path]::GetFullPath($ConfigRoot)
$keys = @(
  'PORT', 'HOST', 'SEATALK_SIGNING_SECRET', 'SEATALK_APP_ID', 'SEATALK_APP_SECRET',
  'SEATALK_ACCESS_TOKEN', 'SEATALK_API_BASE_URL', 'TASK_EXTRACTOR', 'HOLIDAY_DATES',
  'CHATFLOW_API_URL', 'CHATFLOW_API_TOKEN', 'COMPASS_BASE_URL', 'COMPASS_API_KEY', 'COMPASS_MODEL',
  'GOOGLE_SHEETS_SPREADSHEET_ID', 'GOOGLE_SHEETS_SHEET_NAME', 'GOOGLE_SHEETS_RANGE',
  'GOOGLE_SHEETS_WRITE_ENABLED', 'GOOGLE_SERVICE_ACCOUNT_KEY_PATH', 'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REDIRECT_URI', 'AUTH_ALLOWLIST_PATH',
  'AUTH_SESSION_SECRET', 'AUTH_SESSION_TTL_DAYS', 'AUTH_DISABLED'
)
$values = [ordered]@{}
foreach ($key in $keys) { $values[$key] = [Environment]::GetEnvironmentVariable($key) }
$unknown = @()
$envLines = @()
$envPath = Join-Path $ConfigRoot '.env'
if (Test-Path -LiteralPath $envPath -PathType Leaf) { $envLines = [System.IO.File]::ReadLines($envPath) }
foreach ($line in $envLines) {
  $match = [regex]::Match($line, '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$')
  if (-not $match.Success) { continue }
  $name = $match.Groups[1].Value
  if ($keys -notcontains $name) { $unknown += $name; continue }
  if (-not $values[$name]) { $values[$name] = [regex]::Replace($match.Groups[2].Value, '^[''"]|[''"]$', '') }
}
foreach ($key in $keys) {
  if ($values[$key] -match '[\r\n]') { throw ('Multiline configuration is unsupported: ' + $key) }
}
foreach ($key in @('SEATALK_SIGNING_SECRET', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_SHEETS_SPREADSHEET_ID')) {
  if ([string]::IsNullOrWhiteSpace($values[$key])) { throw ('Missing required configuration: ' + $key) }
}
if ($values['AUTH_DISABLED'] -eq 'true') { throw 'AUTH_DISABLED=true cannot be packaged for public deployment.' }
if ($values['SEATALK_APP_ID'] -and $values['SEATALK_APP_SECRET']) {
  $values.Remove('SEATALK_ACCESS_TOKEN')
  $seaTalkMode = 'app_credentials'
} elseif ($values['SEATALK_ACCESS_TOKEN']) {
  $values.Remove('SEATALK_APP_ID')
  $values.Remove('SEATALK_APP_SECRET')
  $seaTalkMode = 'preissued_token'
} else { throw 'SeaTalk requires App ID/Secret or a pre-issued access token.' }

$chatflowReady = $values['CHATFLOW_API_URL'] -and $values['CHATFLOW_API_TOKEN']
$compassReady = [bool]$values['COMPASS_API_KEY']
if ($Extractor -eq 'chatflow' -and -not $chatflowReady) { throw 'Selected Chatflow extractor is missing configuration.' }
if ($Extractor -eq 'compass' -and -not $compassReady) { throw 'Selected Compass extractor is missing configuration.' }
$resolvedExtractor = $Extractor
if ($Extractor -eq 'auto') {
  $resolvedExtractor = 'rules'
  if ($chatflowReady) { $resolvedExtractor = 'chatflow' } elseif ($compassReady) { $resolvedExtractor = 'compass' }
}
if ($Extractor -notin @('chatflow', 'auto')) { $values.Remove('CHATFLOW_API_URL'); $values.Remove('CHATFLOW_API_TOKEN') }
if ($Extractor -notin @('compass', 'auto')) { $values.Remove('COMPASS_BASE_URL'); $values.Remove('COMPASS_API_KEY'); $values.Remove('COMPASS_MODEL') }

try { $origin = [uri]$PublicOrigin } catch { throw 'PublicOrigin must be an HTTPS origin.' }
if (-not $origin.IsAbsoluteUri -or $origin.Scheme -ne 'https' -or $origin.Host -in @('localhost', '127.0.0.1', '[::1]') -or $origin.AbsolutePath -ne '/' -or $origin.Query -or $origin.Fragment -or $origin.UserInfo) {
  throw 'PublicOrigin must be a public HTTPS origin without a path, query, or user information.'
}
function Resolve-ConfigPath([string]$configured, [string]$fallback) {
  if (-not $configured) { $configured = $fallback }
  if ([System.IO.Path]::IsPathRooted($configured)) { return [System.IO.Path]::GetFullPath($configured) }
  return [System.IO.Path]::GetFullPath((Join-Path $ConfigRoot $configured))
}
$allowlistPath = Resolve-ConfigPath $values['AUTH_ALLOWLIST_PATH'] '.auth/allowlist.json'
$keyPath = Resolve-ConfigPath $values['GOOGLE_SERVICE_ACCOUNT_KEY_PATH'] '.auth/google-service-account.json'
if (-not (Test-Path -LiteralPath $allowlistPath -PathType Leaf)) { throw 'Dashboard allowlist file is missing.' }
if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) { throw 'Sheets service-account key file is missing.' }
try { $allowlist = [System.IO.File]::ReadAllText($allowlistPath) | ConvertFrom-Json } catch { throw 'Dashboard allowlist is invalid JSON.' }
if ($allowlist.owners -isnot [array] -or $allowlist.viewers -isnot [array]) { throw 'Allowlist requires owners and viewers arrays.' }
$emails = @($allowlist.owners) + @($allowlist.viewers)
if ($emails.Count -eq 0) { throw 'Dashboard allowlist cannot be empty.' }
foreach ($email in $emails) {
  if ($email -isnot [string] -or $email.Trim() -notmatch '^[^\s@]+@[^\s@]+$') { throw 'Allowlist contains an invalid email entry.' }
}
try { $serviceKey = [System.IO.File]::ReadAllText($keyPath) | ConvertFrom-Json } catch { throw 'Service-account key is invalid JSON.' }
if (-not $serviceKey.client_email -or -not $serviceKey.private_key -or $serviceKey.private_key -notmatch '^-----BEGIN PRIVATE KEY-----') { throw 'Service-account key is missing required fields.' }
if ($serviceKey.token_uri -and $serviceKey.token_uri -ne 'https://oauth2.googleapis.com/token') { throw 'Unexpected service-account token endpoint; review it before deployment.' }

$values['HOST'] = '0.0.0.0'
$values['PORT'] = [string]$Port
$values['AUTH_DISABLED'] = 'false'
$values['TASK_EXTRACTOR'] = $Extractor
$values['GOOGLE_OAUTH_REDIRECT_URI'] = $origin.GetLeftPart([System.UriPartial]::Authority) + '/auth/google/callback'
$values['AUTH_ALLOWLIST_PATH'] = '.auth/allowlist.json'
$values['GOOGLE_SERVICE_ACCOUNT_KEY_PATH'] = '.auth/google-service-account.json'
if (-not $values['GOOGLE_SHEETS_SHEET_NAME']) { $values['GOOGLE_SHEETS_SHEET_NAME'] = 'Sheet1' }
if (-not $values['GOOGLE_SHEETS_RANGE']) { $values['GOOGLE_SHEETS_RANGE'] = 'A:I' }
if (-not $values['GOOGLE_SHEETS_WRITE_ENABLED']) { $values['GOOGLE_SHEETS_WRITE_ENABLED'] = 'false' }
$sessionPath = Join-Path $ConfigRoot '.auth/session-secret'
$includeSessionFile = -not $values['AUTH_SESSION_SECRET'] -and (Test-Path -LiteralPath $sessionPath -PathType Leaf)
$sessionContinuity = 'new_secret_on_startup'
if ($values['AUTH_SESSION_SECRET']) { $sessionContinuity = 'explicit_secret' } elseif ($includeSessionFile) { $sessionContinuity = 'persisted_file' }

$branch = & git -C $repoRoot branch --show-current
if ($LASTEXITCODE -ne 0 -or $branch -ne 'master') { throw 'Run this deployment packager on master.' }
$runtimeChanges = & git -C $repoRoot status --porcelain --untracked-files=all -- package.json server.js src rules public
if ($LASTEXITCODE -ne 0 -or $runtimeChanges) { throw 'Commit intended runtime changes before packaging committed source.' }
$revision = & git -C $repoRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify the committed revision.' }
if (-not $OutputZip) { $OutputZip = Join-Path ([System.IO.Path]::GetTempPath()) ('duck-' + $revision.Substring(0, 7) + '-' + [guid]::NewGuid().ToString('N') + '.zip') }
$OutputZip = [System.IO.Path]::GetFullPath($OutputZip)
if ($OutputZip.StartsWith($repoRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Credential-bearing ZIP must be outside the repository.' }
if (Test-Path -LiteralPath $OutputZip) { throw 'Output ZIP already exists; choose a new path.' }
if (-not (Test-Path -LiteralPath ([System.IO.Path]::GetDirectoryName($OutputZip)) -PathType Container)) { throw 'Output ZIP parent directory is missing.' }

Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
try {
  & git -C $repoRoot archive --format=zip ("--output=" + $OutputZip) HEAD package.json server.js src rules public
  if ($LASTEXITCODE -ne 0) { throw 'git archive failed.' }
  $zip = [System.IO.Compression.ZipFile]::Open($OutputZip, [System.IO.Compression.ZipArchiveMode]::Update)
  try {
    $writer = [System.IO.StreamWriter]::new($zip.CreateEntry('.env').Open(), [System.Text.UTF8Encoding]::new($false))
    try {
      foreach ($key in $values.Keys) { if ($values[$key]) { $writer.WriteLine($key + '=' + $values[$key]) } }
    } finally { $writer.Dispose() }
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $allowlistPath, '.auth/allowlist.json')
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $keyPath, '.auth/google-service-account.json')
    if ($includeSessionFile) { [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $sessionPath, '.auth/session-secret') }
    $entryCount = $zip.Entries.Count
  } finally { $zip.Dispose() }
} catch {
  if (Test-Path -LiteralPath $OutputZip -PathType Leaf) { Remove-Item -LiteralPath $OutputZip }
  throw
} finally {
  $values.Clear()
  $serviceKey = $null
}
[pscustomobject]@{
  archivePath = $OutputZip
  revision = $revision
  entries = $entryCount
  requestedExtractor = $Extractor
  resolvedExtractor = $resolvedExtractor
  seaTalkMode = $seaTalkMode
  sessionContinuity = $sessionContinuity
  omittedUnknownVariableNames = @($unknown | Sort-Object -Unique)
} | ConvertTo-Json -Compress
