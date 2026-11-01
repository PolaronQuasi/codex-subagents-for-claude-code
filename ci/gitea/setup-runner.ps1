[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][uri]$Server,
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][uri]$ContainerServer,
    [Parameter(Mandatory = $true)][string]$DockerNetwork
)
$ErrorActionPreference = 'Stop'
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Repository must be OWNER/REPO' }
foreach ($address in @($Server, $ContainerServer)) {
    if ($address.Scheme -notin @('https', 'http') -or $address.UserInfo -or $address.Query -or $address.Fragment -or $address.AbsoluteUri -match '[\r\n$#]') { throw 'Invalid Gitea URL' }
}
if ($DockerNetwork -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Invalid Docker network name' }
foreach ($requiredCommand in @('git', 'docker')) { Get-Command $requiredCommand -ErrorAction Stop | Out-Null }
docker network inspect $DockerNetwork --format '{{.Name}}'
if ($LASTEXITCODE -ne 0) { throw 'Gitea Docker network does not exist' }

# Only connection settings go into .env. Registration credentials live in a Docker volume.
$settings = "GITEA_INSTANCE_URL=$($ContainerServer.AbsoluteUri.TrimEnd('/'))`nGITEA_DOCKER_NETWORK=$DockerNetwork`n"
$settingsPath = Join-Path $PSScriptRoot '.env'
if (Test-Path -LiteralPath $settingsPath) {
    if ((Get-Content -LiteralPath $settingsPath -Raw).Trim() -ne $settings.Trim()) { throw 'Existing .env differs; review it before changing the runner server or network' }
} else {
    [IO.File]::WriteAllText($settingsPath, $settings, [Text.UTF8Encoding]::new($false))
}
$compose = @('compose', '--project-directory', $PSScriptRoot, '-f', (Join-Path $PSScriptRoot 'compose.yml'))
& docker @compose build --pull
if ($LASTEXITCODE -ne 0) { throw 'Runner image build failed' }

# Reuse Git Credential Manager in memory; never print or persist its repository credential.
$credentialInput = "protocol=$($Server.Scheme)`nhost=$($Server.Authority)`npath=$Repository.git`n`n"
$credentialLines = $credentialInput | git credential fill
if ($LASTEXITCODE -ne 0) { throw 'Git credential lookup failed' }
$credentialFields = @{}
foreach ($line in $credentialLines) { $pair = $line -split '=', 2; if ($pair.Length -eq 2) { $credentialFields[$pair[0]] = $pair[1] } }
$headers = @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($credentialFields.username + ':' + $credentialFields.password)) }
$api = $Server.AbsoluteUri.TrimEnd('/') + "/api/v1/repos/$Repository"

# checkout and asset downloads need an address reachable from the container.
$variableUrl = "$api/actions/variables/CODEX_SUBAGENTS_FOR_CLAUDE_CODE_FORGE_URL"
$variableBody = @{ value = $ContainerServer.AbsoluteUri.TrimEnd('/'); description = 'Gitea URL reachable by the Docker runner' } | ConvertTo-Json
try { $null = Invoke-RestMethod -Uri $variableUrl -Headers $headers; $variableMethod = 'Put' }
catch { if ([int]$_.Exception.Response.StatusCode -ne [Net.HttpStatusCode]::NotFound) { throw }; $variableMethod = 'Post' }
$null = Invoke-RestMethod -Uri $variableUrl -Method $variableMethod -Headers $headers -ContentType 'application/json' -Body $variableBody

$registrationResponse = Invoke-RestMethod -Uri "$api/actions/runners/registration-token" -Headers $headers
$previousToken = $env:GITEA_RUNNER_REGISTRATION_TOKEN
try {
    $env:GITEA_RUNNER_REGISTRATION_TOKEN = $registrationResponse.token
    & docker @compose run --rm -T -e GITEA_RUNNER_REGISTRATION_TOKEN runner register
    if ($LASTEXITCODE -ne 0) { throw 'Runner registration failed' }
} finally { $env:GITEA_RUNNER_REGISTRATION_TOKEN = $previousToken }
& docker @compose up -d --wait
if ($LASTEXITCODE -ne 0) { throw 'Runner startup or health check failed' }
Write-Output "Docker Compose runner started for $Repository. Registration and caches are in named volumes."
