# Gitea 1.24's private attachment route cannot use an Actions job token.
# Provision a restricted, read-only account for download verification only.
# -RepairIncomplete resumes an inspected, interrupted attempt for this repository: it resets the
# existing reader's password and limits, deletes the token an earlier attempt may have left
# unstored, then creates and stores a new one. It refuses a reader provisioned for another
# repository, whose token that repository still uses.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][uri]$Server,
    [Parameter(Mandatory = $true)][string]$Repository,
    [string]$Username = 'codex-subagents-for-claude-code-assets',
    [switch]$RepairIncomplete
)
$ErrorActionPreference = 'Stop'
if ($Server.Scheme -notin @('https', 'http') -or $Server.UserInfo -or $Server.Query -or $Server.Fragment) { throw 'Invalid Gitea URL' }
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $Username -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Invalid repository or account name' }
$credentialLines = "protocol=$($Server.Scheme)`nhost=$($Server.Authority)`n`n" | git credential fill
if ($LASTEXITCODE -ne 0) { throw 'Git credential lookup failed' }
$credentials = @{}
foreach ($line in $credentialLines) { $pair = $line -split '=', 2; if ($pair.Length -eq 2) { $credentials[$pair[0]] = $pair[1] } }
$headers = @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($credentials.username + ':' + $credentials.password)) }
$api = $Server.AbsoluteUri.TrimEnd('/') + '/api/v1'
$repoApi = "$api/repos/$Repository"
$secrets = Invoke-RestMethod -Uri "$repoApi/actions/secrets" -Headers $headers
if (@($secrets).name -contains 'CODEX_SUBAGENTS_FOR_CLAUDE_CODE_ASSET_TOKEN') {
    Write-Output 'Asset verification secret already exists; preserving it.'
    return
}
$me = Invoke-RestMethod -Uri "$api/user" -Headers $headers
if (-not $me.is_admin) { throw 'An instance administrator must provision the restricted reader account' }
try { $existing = Invoke-RestMethod -Uri "$api/users/$Username" -Headers $headers }
catch { if ([int]$_.Exception.Response.StatusCode -ne [Net.HttpStatusCode]::NotFound) { throw }; $existing = $null }
$provisionedFor = "Read-only asset verification for $Repository"
if ($existing -and $RepairIncomplete -and $existing.description -and $existing.description -ne $provisionedFor) {
    throw "The reader account $Username was provisioned for another repository ($($existing.description)); choose another -Username for $Repository"
}
if ($existing -and (-not $RepairIncomplete -or $existing.is_admin -or $existing.full_name -ne 'codex-subagents-for-claude-code asset verifier' -or $existing.email -ne "$Username@users.noreply.invalid")) {
    throw 'The reader account name already exists; inspect it before using -RepairIncomplete for an interrupted provisioning attempt'
}

$randomBytes = New-Object byte[] 48
$generator = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $generator.GetBytes($randomBytes) } finally { $generator.Dispose() }
$password = 'aA1!' + [Convert]::ToBase64String($randomBytes)
try {
    $create = @{
        username = $Username; email = "$Username@users.noreply.invalid"; password = $password
        full_name = 'codex-subagents-for-claude-code asset verifier'; must_change_password = $false
        restricted = $true; visibility = 'private'; send_notify = $false
    } | ConvertTo-Json
    if (-not $existing) { $null = Invoke-RestMethod -Uri "$api/admin/users" -Method Post -Headers $headers -ContentType 'application/json' -Body $create }
    $limits = @{
        login_name = $Username; source_id = 0; password = $password; must_change_password = $false
        max_repo_creation = 0; allow_create_organization = $false; allow_git_hook = $false
        allow_import_local = $false; admin = $false; restricted = $true
        description = $provisionedFor
    } | ConvertTo-Json
    $null = Invoke-RestMethod -Uri "$api/admin/users/$Username" -Method Patch -Headers $headers -ContentType 'application/json' -Body $limits
    $null = Invoke-RestMethod -Uri "$repoApi/collaborators/$Username" -Method Put -Headers $headers -ContentType 'application/json' -Body '{"permission":"read"}'

    $readerHeaders = @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Username + ':' + $password)) }
    $tokenName = 'codex-subagents-for-claude-code-asset-download'
    if ($RepairIncomplete -and $existing) {
        # An interrupted attempt can leave a token whose value was never stored, and Gitea refuses
        # a second token with the same name. The reader, who owns the token, deletes it: the least
        # privilege that can. 404 means there is none.
        try {
            $null = Invoke-RestMethod -Uri "$api/users/$Username/tokens/$tokenName" -Method Delete -Headers $readerHeaders
            Write-Output "Deleted the $tokenName token that an interrupted attempt left unstored."
        } catch {
            if ([int]$_.Exception.Response.StatusCode -ne [Net.HttpStatusCode]::NotFound) { throw }
        }
    }
    $tokenBody = @{ name = $tokenName; scopes = @('read:repository') } | ConvertTo-Json
    $readerToken = Invoke-RestMethod -Uri "$api/users/$Username/tokens" -Method Post -Headers $readerHeaders -ContentType 'application/json' -Body $tokenBody
    $tokenHeaders = @{ Authorization = 'token ' + $readerToken.sha1 }
    $access = Invoke-RestMethod -Uri $repoApi -Headers $tokenHeaders
    if (-not $access.permissions.pull -or $access.permissions.push -or $access.permissions.admin) { throw 'Reader account does not have the expected read-only repository access' }
    $secretBody = @{ data = $readerToken.sha1; description = "Read-only private attachment verification as $Username" } | ConvertTo-Json
    $null = Invoke-RestMethod -Uri "$repoApi/actions/secrets/CODEX_SUBAGENTS_FOR_CLAUDE_CODE_ASSET_TOKEN" -Method Put -Headers $headers -ContentType 'application/json' -Body $secretBody
    Write-Output "Configured $Username with read-only access to $Repository; token stored as an encrypted repository Actions secret."
} finally {
    $password = $null
    $readerToken = $null
    $readerHeaders = $null
    $tokenHeaders = $null
    $secretBody = $null
    $create = $null
    $limits = $null
}
