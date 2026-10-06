# Sets up the current PowerShell session to inspect gemini-cli.
#
#   . .\setup.ps1                       # capture into .\.gemini-wiretap
#   . .\setup.ps1 -Dir D:\my\captures   # custom capture directory
#   . .\setup.ps1 -Scope model          # skip OAuth token refreshes
#   . .\setup.ps1 -Log                  # print one line per captured exchange
#
# Dot-source it (note the leading dot) so the variables land in YOUR session.
# Undo with:  . .\setup.ps1 -Unset

[CmdletBinding()]
param(
  [string]$Dir,
  [ValidateSet('google', 'model', 'all')][string]$Scope = 'google',
  # Not named -Verbose: that collides with PowerShell's common parameter.
  [switch]$Log,
  [switch]$Unset
)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$reg = Join-Path $here 'register.cjs'

# Variables this script touches, plus where their pre-existing values are stashed
# so -Unset restores them instead of deleting them (NODE_OPTIONS may already be
# in use for other tools, e.g. --max-old-space-size).
#
# Note: Test-Path Env:\X reports TRUE for a variable that exists but is an empty
# string, so presence checks use [Environment]::GetEnvironmentVariable, which
# returns $null only when the variable is genuinely absent. That distinction
# matters here: an empty NODE_OPTIONS must be restored as absent, not as ''.
$managed = @('NODE_OPTIONS', 'GEMINI_WIRETAP_DIR', 'GEMINI_WIRETAP_SCOPE', 'GEMINI_WIRETAP_VERBOSE')
$savePrefix = 'GEMINI_INSPECT_SAVED_'
$armedMarker = 'GEMINI_INSPECT_SAVED_MARKER'

function Get-EnvOrNull([string]$name) {
  return [Environment]::GetEnvironmentVariable($name, 'Process')
}

function Set-EnvOrRemove([string]$name, $value) {
  if ($null -eq $value) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
  } else {
    [Environment]::SetEnvironmentVariable($name, [string]$value, 'Process')
  }
}

if ($Unset) {
  $armed = $null -ne (Get-EnvOrNull $armedMarker)
  foreach ($name in $managed) {
    if ($armed) {
      # Restore the stashed original: $null means it was absent, '' means empty.
      Set-EnvOrRemove $name (Get-EnvOrNull "$savePrefix$name")
    } else {
      # Never armed; leave the caller's environment alone.
    }
  }
  if ($armed) {
    foreach ($name in $managed) {
      [Environment]::SetEnvironmentVariable("$savePrefix$name", $null, 'Process')
    }
    [Environment]::SetEnvironmentVariable($armedMarker, $null, 'Process')
  }
  Write-Host $(if ($armed) { '[inspector] environment restored' } else { '[inspector] was not armed; nothing changed' }) -ForegroundColor Yellow
  if ($env:NODE_OPTIONS) { Write-Host "  NODE_OPTIONS is back to: $env:NODE_OPTIONS" }
  return
}

if (-not (Test-Path $reg)) {
  Write-Error "register.cjs not found next to this script ($reg)"
  return
}

# Stash originals once per session, before we overwrite anything.
if ($null -eq (Get-EnvOrNull $armedMarker)) {
  foreach ($name in $managed) {
    [Environment]::SetEnvironmentVariable("$savePrefix$name", (Get-EnvOrNull $name), 'Process')
  }
  [Environment]::SetEnvironmentVariable($armedMarker, '1', 'Process')
}

# Every Node process in this session loads register.cjs. The shim no-ops in the
# CLI's launcher process, so only the process that talks to the model is hooked.
#
# No quotes around the path: Node's NODE_OPTIONS parser rejects quoted values
# outright ("--require is not allowed in NODE_OPTIONS" / parse error). That also
# means the path must not contain spaces or non-ASCII characters.
$env:NODE_OPTIONS = "--require $reg"
if ($reg -match '[^\x20-\x7E]') {
  Write-Warning "[inspector] hook path contains non-ASCII characters; Node's NODE_OPTIONS parser may reject it: $reg"
}
if ($reg -match '\s') {
  Write-Warning "[inspector] hook path contains spaces; move this directory somewhere space-free (e.g. D:\codes\gemini-inspector): $reg"
}
$env:GEMINI_WIRETAP_SCOPE = $Scope
if ($Dir) { $env:GEMINI_WIRETAP_DIR = $Dir } else { Remove-Item Env:\GEMINI_WIRETAP_DIR -ErrorAction SilentlyContinue }
if ($Log) { $env:GEMINI_WIRETAP_VERBOSE = '1' } else { Remove-Item Env:\GEMINI_WIRETAP_VERBOSE -ErrorAction SilentlyContinue }

$target = if ($Dir) { $Dir } else { Join-Path (Get-Location) '.gemini-wiretap' }
Write-Host '[inspector] armed' -ForegroundColor Green
Write-Host "  hook        : $reg"
Write-Host "  captures to : $target"
Write-Host "  scope       : $Scope"
Write-Host ''
Write-Host '  run:    gemini'
Write-Host "  watch:  node `"$here\panel.mjs`" --dir `"$target`""
Write-Host '  undo:   . .\setup.ps1 -Unset'
Write-Host ''
Write-Host 'Note: NODE_OPTIONS also applies to other Node tools in this session.' -ForegroundColor DarkYellow
