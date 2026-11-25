[CmdletBinding()]
param([switch]$ValidateOnly)

$ErrorActionPreference = 'Stop'

# Capture streams separately in memory: normal CLI progress on stderr must not
# cause NativeCommandError in Windows PowerShell 5.1. Only ExitCode decides success.
function Invoke-Native {
    param([string]$FilePath, [string[]]$Arguments = @(),
          [AllowEmptyString()][string]$InputText = '', [string]$Step = 'Native command')
    $process = New-Object System.Diagnostics.Process
    try {
        foreach ($argument in $Arguments) {
            if ($argument -match '["%!\r\n]' -or $argument.EndsWith('\')) { throw 'Unsupported argument.' }
        }
        $quoted = (@($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' ')
        $info = $process.StartInfo
        $info.WorkingDirectory = $PSScriptRoot
        if ($FilePath.EndsWith('.cmd', [StringComparison]::OrdinalIgnoreCase)) {
            if ($FilePath -match '["%!\r\n]') { throw 'Unsupported CLI path.' }
            $info.FileName = $env:ComSpec
            $info.Arguments = '/d /s /c ""' + $FilePath + '" ' + $quoted + '"'
        } else {
            $info.FileName = $FilePath
            $info.Arguments = $quoted
        }
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.RedirectStandardInput = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        $info.StandardOutputEncoding = $utf8
        $info.StandardErrorEncoding = $utf8
        $info.EnvironmentVariables['VERCEL_TELEMETRY_DISABLED'] = '1'
        if (-not $process.Start()) { throw 'Could not start command.' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        # Framework PowerShell 5.1 has no StandardInputEncoding property.
        $stdin = New-Object System.IO.StreamWriter($process.StandardInput.BaseStream, $utf8)
        $stdin.Write($InputText)
        $stdin.Close()
        $process.WaitForExit()
        $outputText = $stdout.GetAwaiter().GetResult()
        $errorText = $stderr.GetAwaiter().GetResult()
        $exitCode = $process.ExitCode
        if ($exitCode -ne 0) {
            # CLI errors can contain submitted values. Never echo either stream.
            throw "$Step failed (exit code $exitCode). Output withheld to protect secrets."
        }
        return [pscustomobject]@{ Stdout = $outputText; Stderr = $errorText; ExitCode = $exitCode }
    } catch {
        if ($_.Exception.Message -like "$Step failed (exit code *") { throw }
        throw "$Step could not complete. Check Node.js, CLI and network in normal PowerShell. No values were printed."
    } finally {
        $InputText = $null
        $outputText = $null
        $errorText = $null
        $process.Dispose()
    }
}

function Convert-CommandJson {
    param($Result, [string]$Step)
    try { return ($Result.Stdout | ConvertFrom-Json) }
    catch { throw "$Step returned unexpected JSON. Output withheld to protect secrets." }
}

function Assert-UploadAllowlist {
    $expected = @('*','!server.js','!package.json','!package-lock.json','!vercel.json','!Multilingual_AI_Prompt_Generation_Mobile_Application11.html')
    $actual = @(Get-Content -LiteralPath (Join-Path $PSScriptRoot '.vercelignore') | Where-Object { $_.Trim() })
    # Compare in order: later negation rules could re-include secrets or backups.
    if (($actual -join [char]10) -cne ($expected -join [char]10)) { throw 'Deployment allowlist differs from the reviewed five-file configuration.' }
    foreach ($entry in $expected | Select-Object -Skip 1) {
        $path = Join-Path $PSScriptRoot $entry.Substring(1)
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'A required deployment file is missing.' }
        if ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Deployment files must be regular files, not links.' }
    }
}

Push-Location -LiteralPath $PSScriptRoot
try {
$vercel = (Get-Command vercel.cmd -CommandType Application -ErrorAction Stop).Source
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
$linked = Get-Content -LiteralPath '.vercel/project.json' -Raw | ConvertFrom-Json
if ($linked.projectName -cne 'promptway' -or $linked.projectId -notmatch '^prj_[A-Za-z0-9]+$' -or $linked.orgId -notmatch '^team_[A-Za-z0-9]+$') {
    throw 'An existing linked promptway project and team are required. No project will be created or linked.'
}
$projectId = $linked.projectId
$orgId = $linked.orgId
Assert-UploadAllowlist

# Node parses .env; values stay in memory and are piped through stdin, never CLI arguments.
$readConfig = @'
try {
  const fs = require('node:fs'), { parseEnv } = require('node:util');
  const e = parseEnv(fs.readFileSync('.env', 'utf8'));
  const names = ['GROQ_API_KEY', 'GROQ_MODEL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
  if (names.some(n => typeof e[n] !== 'string' || !e[n].trim() || /[\r\n\0]/.test(e[n]) || e[n] !== e[n].trim())) process.exit(1);
  if (!/^https:\/\/[a-zA-Z0-9-]+\.upstash\.io\/?$/.test(e.UPSTASH_REDIS_REST_URL)) process.exit(1);
  process.stdout.write(JSON.stringify(Object.fromEntries(names.map(n => [n, e[n]]))));
} catch (_) { process.exit(1); }
'@
$configResult = Invoke-Native -FilePath $node -Arguments @('-') -InputText $readConfig -Step 'Read .env (GROQ_API_KEY, GROQ_MODEL and free Upstash REST URL/token required)'
$config = Convert-CommandJson $configResult 'Read .env'
$configResult = $null

if ($ValidateOnly) {
    $probe = Invoke-Native -FilePath $node -Arguments @('-') -InputText "process.stdout.write('ok'); process.stderr.write('normal progress');" -Step 'Native stderr self-test'
    if ($probe.Stdout -cne 'ok' -or $probe.Stderr -cne 'normal progress') { throw 'Native stream separation failed.' }
    $failureDetected = $false
    try {
        $null = Invoke-Native -FilePath $node -Arguments @('-') -InputText 'process.exit(7);' -Step 'Expected failure self-test'
    } catch { $failureDetected = $_.Exception.Message -like '*exit code 7*' }
    if (-not $failureDetected) { throw 'Native exit-code validation failed.' }
    $null = Invoke-Native -FilePath $vercel -Arguments @('--version') -Step 'Vercel CLI check'
    Write-Host 'PASS: linked project, five-file allowlist, .env values, vercel.cmd, stderr and nonzero exit-code handling.'
    Write-Host 'Local validation only: no variables uploaded and no deployment created.'
    return
}

$null = Invoke-Native -FilePath $vercel -Arguments @('whoami') -Step 'Vercel authentication'
$teamResult = Invoke-Native -FilePath $vercel -Arguments @('api', "/v2/teams/$orgId", '--raw') -Step 'Linked team lookup'
$team = Convert-CommandJson $teamResult 'Linked team lookup'
if ($team.team) { $team = $team.team }
if ($team.id -cne $orgId -or $team.billing.plan -cne 'hobby' -or $team.slug -notmatch '^[a-z0-9][a-z0-9-]*$') {
    throw 'The linked team is not a verified Hobby team. No deployment or paid changes were made.'
}
$scope = $team.slug
$projectEndpoint = "/v9/projects/$($projectId)?teamId=$orgId"
$projectResult = Invoke-Native -FilePath $vercel -Arguments @('api', $projectEndpoint, '--raw') -Step 'Linked project lookup'
$project = Convert-CommandJson $projectResult 'Linked project lookup'
if ($project.id -cne $projectId -or $project.name -cne 'promptway' -or $project.accountId -cne $orgId) { throw 'Remote project does not match the existing local link.' }
Write-Host 'Verified existing promptway project on its Hobby team.'

foreach ($name in @('GROQ_API_KEY','GROQ_MODEL','UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN')) {
    $null = Invoke-Native -FilePath $vercel -Arguments @('env', 'add', $name, '--environment', 'production', '--type', 'secret', '--force', '--yes', '--project', $projectId, '--scope', $scope) -InputText $config.$name -Step "Configure $name"
    Write-Host "Configured $name securely for production."
}
$config = $null
# Remove obsolete production demo credentials only when present; safe to rerun.
$envResult = Invoke-Native -FilePath $vercel -Arguments @('api', "/v9/projects/$($projectId)/env?teamId=$orgId", '--raw') -Step 'Environment metadata lookup'
$envMetadata = Convert-CommandJson $envResult 'Environment metadata lookup'
foreach ($name in @('DEMO_USER', 'DEMO_PASSWORD')) {
    if (@($envMetadata.envs | Where-Object { $_.key -ceq $name -and $_.target -contains 'production' }).Count -gt 0) {
        $null = Invoke-Native -FilePath $vercel -Arguments @('env', 'rm', $name, 'production', '--yes', '--scope', $scope) -Step "Remove obsolete $name"
        Write-Host "Removed obsolete $name from production."
    }
}
$envResult = $null
$envMetadata = $null
$null = Invoke-Native -FilePath $vercel -Arguments @('env', 'ls', 'production', '--scope', $scope) -Step 'Production environment listing'

# Refuse to deploy if the existing upload allowlist has changed.
Assert-UploadAllowlist
$null = Invoke-Native -FilePath $vercel -Arguments @('deploy', '--dry', '--json', '--project', $projectId, '--scope', $scope) -Step 'Deployment source inspection'
Write-Host 'Upload allowlist verified: .env, .env.local, backups and all other non-application files are excluded.'
Write-Host 'Deploying production; waiting for Vercel to finish...'
$deployResult = Invoke-Native -FilePath $vercel -Arguments @('deploy', '--prod', '--yes', '--json', '--project', $projectId, '--scope', $scope) -Step 'Production deployment'
$deployment = Convert-CommandJson $deployResult 'Production deployment'
$url = $deployment.url
if (-not $url -and $deployment.deployment) { $url = $deployment.deployment.url }
$url = $url -replace '^https://', ''
if ($url -notmatch '^[a-zA-Z0-9-]+\.vercel\.app$') { throw 'Deployment finished but no valid deployment URL was returned. Check Vercel dashboard.' }
$detailsResult = Invoke-Native -FilePath $vercel -Arguments @('api', "/v13/deployments/$($url)?teamId=$orgId", '--raw') -Step 'Production deployment status'
$details = Convert-CommandJson $detailsResult 'Production deployment status'
if ($details.projectId -cne $projectId -or $details.target -cne 'production' -or $details.readyState -cne 'READY') { throw 'Deployment exists but its production READY status could not be verified.' }
$productionResult = Invoke-Native -FilePath $vercel -Arguments @('api', $projectEndpoint, '--raw') -Step 'Production domain lookup'
$productionProject = Convert-CommandJson $productionResult 'Production domain lookup'
if ($productionProject.targets.production.id -cne $details.id) { throw 'Production does not point at this deployment.' }
$aliases = @($details.alias | Where-Object { $_ -is [string] -and $_ -match '^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$' })
if ($aliases.Count -eq 0) { throw 'Deployment is ready but its production alias could not be verified.' }
$productionUrl = 'https://promptway-omega.vercel.app'
if ($aliases -notcontains 'promptway-omega.vercel.app') { throw 'The existing production domain was not assigned. No new domain was created.' }
Write-Host "Production URL: $productionUrl"

$verify = @'
const assert = require('node:assert/strict');
const { parseEnv } = require('node:util');
(async () => {
  const env = parseEnv(require('node:fs').readFileSync('.env', 'utf8'));
  const [base, deployment] = process.argv.slice(2);
  const request = (url, options = {}) => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(95000), ...options });
  for (const url of new Set([base, deployment])) {
    const r = await request(url);
    assert.equal(r.status, 200, 'Public HTML did not load; check Vercel Deployment Protection if blocked.');
    assert.equal(r.headers.get('www-authenticate'), null, 'Unexpected authentication challenge.');
    assert((await r.text()).includes('fetchGroqPrompts'), 'Unexpected application HTML.');
  }
  for (const path of ['/.env','/.env.local','/server.js','/package.json','/backup/Multilingual_AI_Prompt_Generation_Mobile_Application11.html','/.vercel/project.json']) {
    const r = await request(base + path);
    assert.equal(r.status, 404, 'Confidential route accessible: ' + path);
  }
  let r = await request(base + '/api/groq/prompts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 400, 'Public API must validate unauthenticated input.');
  r = await request(base + '/api/groq/prompts', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    signal: AbortSignal.timeout(95000),
    body: JSON.stringify({ ideaText: 'Write an English AI prompt for three short university science club event captions.', inputLang: 'english', category: 'social', platform: 'ChatGPT', answers: {}, refinement: 'none' })
  });
  assert.equal(r.status, 200, 'Live Groq generation failed. HTTP ' + r.status);
  const result = await r.json();
  assert.equal(result.source, 'groq');
  assert(result.model === env.GROQ_MODEL.trim(), 'Configured model did not match.');
  for (const key of ['basic','detailed','creative','sinhalaSummary','tamilSummary']) assert(typeof result[key] === 'string' && result[key].trim(), 'Missing output: ' + key);
  console.log('PASS: public HTML, public API validation, confidential routes and unauthenticated Groq generation.');
  console.log('Verified HTTPS URL: ' + base);
})().catch(e => {
  // Do not echo network/provider responses or objects containing credentials.
  console.error(e.code === 'ERR_ASSERTION' ? e.message.split('\n')[0] : 'Online verification failed; check connectivity and production settings.');
  process.exitCode = 1;
});
'@
$verification = Invoke-Native -FilePath $node -Arguments @('-', $productionUrl, "https://$url") -InputText $verify -Step 'Live public access and API verification (deployment remains available on failure)'
Write-Host $verification.Stdout.Trim()
Write-Host "Verified production URL: $productionUrl"
} finally {
    $config = $null
    $configResult = $null
    Pop-Location
}
