[CmdletBinding()]
param(
    # Exactly one of -Prompt or -PromptFile is required (mutual exclusion).
    [Parameter(Mandatory = $false)]
    [string]$Prompt,

    [Parameter(Mandatory = $false)]
    [string]$PromptFile,

    [string]$Cwd = (Get-Location).Path,

    [ValidateSet('grok-4.5', 'grok-composer-2.5-fast')]
    [string]$Model = 'grok-4.5',

    # Medium is the budget-safe default. High must be selected explicitly for
    # final implementation/review or a decision that survived a medium pass.
    [ValidateSet('low', 'medium', 'high')]
    [string]$ReasoningEffort = 'medium',

    [ValidateRange(10, 120)]
    [int]$MaxTurns = 60,

    # How many times to re-run when the completion marker is missing.
    # Not used for quota/auth failures (those never retry).
    [ValidateRange(0, 3)]
    [int]$MaxRetries = 1,

    # Select how much autonomy Grok receives. Open is the default general-purpose helper mode.
    [ValidateSet('open', 'plan', 'readonly')]
    [string]$CapabilityMode = 'open',

    # Explicitly replay an incomplete/timeout attempt. Disabled by default because open-mode
    # tasks may have side effects before the process becomes uncertain.
    [switch]$AllowRetrySideEffects,

    # Seconds to wait for the exclusive consult lock (parallel calls).

    # Seconds allowed for one Grok CLI process before its full process tree is terminated.
    [ValidateRange(1, 3600)]
    [int]$ProcessTimeoutSec = 300,

    # Maximum seconds for the complete invocation, including bounded retries.
    [ValidateRange(1, 7200)]
    [int]$OverallTimeoutSec = 900,

    # Seconds to wait for the exclusive consult lock (parallel Codex calls).

    # How the wrapper emits its final result to stdout.
    # plain: review text only (default; preserves existing callers).
    # json: single JSON object with status fields and the review body.
    [ValidateSet('plain', 'json')]
    [string]$ResultFormat = 'plain',

    # Suppress progress / retry messages on the host (Write-Host).
    # Errors and the final result still go to the appropriate streams.
    [switch]$Quiet,

    # Keep per-attempt diagnostic logs instead of overwriting the single last.log.
    # Files: %TEMP%\prepforge-grok-consult-attempt-N.log plus last.log for the final attempt.
    [switch]$KeepAttemptLogs
)

$ErrorActionPreference = 'Stop'

# Mutual exclusion: exactly one of -Prompt / -PromptFile.
$hasPrompt = -not [string]::IsNullOrWhiteSpace($Prompt)
$hasPromptFile = -not [string]::IsNullOrWhiteSpace($PromptFile)
if ($hasPrompt -and $hasPromptFile) {
    throw 'Specify either -Prompt or -PromptFile, not both.'
}
if (-not $hasPrompt -and -not $hasPromptFile) {
    throw 'Either -Prompt or -PromptFile is required.'
}
if ($hasPromptFile) {
    $resolvedPromptFile = (Resolve-Path -LiteralPath $PromptFile -ErrorAction Stop).Path
    # Explicit UTF-8: BOM-less files must not be decoded as system ANSI on Windows.
    $Prompt = [System.IO.File]::ReadAllText(
        $resolvedPromptFile,
        (New-Object System.Text.UTF8Encoding($false, $false))
    )
    if ([string]::IsNullOrWhiteSpace($Prompt)) {
        throw "Prompt file is empty: $resolvedPromptFile"
    }
}

$grok = Get-Command grok.exe -ErrorAction SilentlyContinue
if (-not $grok) {
    throw 'Grok Build CLI was not found on PATH. Install it or add C:\Users\andre\.grok\bin to PATH.'
}

$resolvedCwd = (Resolve-Path -LiteralPath $Cwd -ErrorAction Stop).Path

# The completion marker is retained for review-compatible callers; open tasks also require
# clean exit and non-empty output, so arbitrary helper work is not forced to emit review prose.
$completionMarker = 'GROK_REVIEW_COMPLETE'

$permissionMode = switch ($CapabilityMode) {
    'open' { 'bypassPermissions' }
    'plan' { 'plan' }
    'readonly' { 'plan' }
}
$allowAllTools = ($CapabilityMode -eq 'open')
$readOnlyTools = 'read_file,grep,list_dir'

function Write-ConsultHost {
    param(
        [string]$Message,
        [ConsoleColor]$ForegroundColor = [ConsoleColor]::Yellow
    )
    if ($Quiet) { return }
    Write-Host $Message -ForegroundColor $ForegroundColor
}

function New-WrappedPrompt {
    param(
        [string]$Task,
        [int]$Attempt,
        [string]$PriorSnippet
    )

    $retryBlock = ''
    if ($Attempt -gt 1) {
        $retryBlock = @"

RETRY CONTEXT (attempt $Attempt):
A previous attempt did not finish cleanly. Continue the requested task and verify the current
state before taking further action. Do not assume that a timed-out action did or did not complete.
"@
        if (-not [string]::IsNullOrWhiteSpace($PriorSnippet)) {
            $retryBlock += @"

Prior incomplete output (context only; re-verify before trusting):
$PriorSnippet
"@
        }
    }

    return @"
You are Grok acting as a general-purpose coding assistant for the user.

Complete the task below, using the repository and tools available in this session as needed.
You may inspect, edit, create, delete, build, test, and run commands when the task requires it.
Use your judgment, keep changes scoped to the request, and report exactly what you did.
Do not stop at acknowledgements or progress updates. Verify important changes before finishing.
Do not call enter_plan_mode / exit_plan_mode; deliver the result in your final message.
$retryBlock
TASK:
$Task

When the task is genuinely finished, provide a concise final report. For review-compatible
callers, end with this exact standalone line:
$completionMarker
"@
}

function Get-Snippet {
    param([string]$Text, [int]$MaxChars = 1200)
    if ([string]::IsNullOrWhiteSpace($Text)) { return '' }
    $t = $Text.Trim()
    if ($t.Length -le $MaxChars) { return $t }
    return $t.Substring([Math]::Max(0, $t.Length - $MaxChars))
}

function Test-IncompleteReview {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $true }
    # Finished only when the last non-empty line is exactly the marker.
    # Avoids false "complete" if the model echoes the instruction mid-stream then aborts.
    $lastNonEmpty = $null
    foreach ($line in ($Text -split "`r?`n")) {
        if (-not [string]::IsNullOrWhiteSpace($line)) {
            $lastNonEmpty = $line.Trim()
        }
    }
    return ($lastNonEmpty -ne $completionMarker)
}

# Classify failures that must never burn retries (quota / auth).
# Returns a short reason string when no-retry applies; otherwise $null.
function Get-NoRetryReason {
    param(
        [string]$Text,
        [int]$ExitCode
    )
    if ([string]::IsNullOrWhiteSpace($Text) -and $ExitCode -eq 0) {
        return $null
    }
    $t = if ($null -eq $Text) { '' } else { $Text }

    # Quota / usage exhaustion — do not re-probe.
    if ($t -match '(?i)(usage|quota).{0,40}(exhaust|exceed|limit|remaining|capaci)|(?i)(exhaust|exceed).{0,40}(usage|quota)|(?i)rate.?limit|(?i)no remaining (usage|quota|capacity)|(?i)out of (usage|quota|credits)') {
        return 'quota'
    }
    # Authentication / login required — fix credentials, do not retry the same call.
    if ($t -match '(?i)not logged in|(?i)please (run |use )?grok login|(?i)authentication (failed|required|error)|(?i)unauthori[sz]ed|(?i)invalid (api )?key|(?i)login required|(?i)auth(entication)? (token|session).{0,20}(expired|invalid|missing)') {
        return 'auth'
    }
    return $null
}

function Write-ConsultResult {
    param(
        [string]$OutputText,
        [int]$ExitCode,
        [bool]$Complete,
        [int]$Attempts,
        [string]$LogPath,
        [string]$NoRetryReason,
        [bool]$IsError
    )

    if ($ResultFormat -eq 'json') {
        $obj = [ordered]@{
            success         = (-not $IsError -and $Complete -and $ExitCode -eq 0)
            complete        = $Complete
            exitCode        = $ExitCode
            attempts        = $Attempts
            noRetryReason   = $NoRetryReason
            logPath         = $LogPath
            output          = $OutputText
            completionMarker = $completionMarker
            capabilityMode   = $CapabilityMode
            permissionMode   = $permissionMode
            timedOut         = $lastTimedOut
        }
        # Compress ensures a single stdout line-friendly blob for callers that parse JSON.
        ($obj | ConvertTo-Json -Compress -Depth 6)
        return
    }

    # plain (default): preserve prior behavior — emit the review body on stdout.
    if (-not [string]::IsNullOrWhiteSpace($OutputText)) {
        $OutputText.TrimEnd()
    }
}

function ConvertTo-ProcessArgument {
    param([string]$Value)
    if ($null -eq $Value -or $Value.Length -eq 0) { return '""' }
    # CommandLineToArgvW-compatible quoting for Windows process startup.
    return '"' + ([regex]::Replace($Value, '(\\*)"', '$1$1\\"') -replace '(\\+)$', '$1$1') + '"'
}

function Stop-ProcessTree {
    param([System.Diagnostics.Process]$Process)
    if ($null -eq $Process) { return }
    try {
        if (-not $Process.HasExited) {
            try {
                $killTree = [System.Diagnostics.Process].GetMethod('Kill', [Type[]]@([bool]))
                if ($null -ne $killTree) { $Process.Kill($true) }
                else { & taskkill.exe /PID $Process.Id /T /F *> $null }
            }
            catch { try { & taskkill.exe /PID $Process.Id /T /F *> $null } catch {} }
        }
    }
    catch {}
    try { $Process.WaitForExit(5000) } catch {}
}

function Invoke-GrokConsultOnce {
    param(
        [string]$WrappedPrompt,
        [string]$OutLogPath,
        [int]$TimeoutSec
    )

    $promptFilePath = Join-Path $env:TEMP ("prepforge-grok-prompt-{0}.txt" -f [Guid]::NewGuid().ToString('N'))
    $stdoutPath = Join-Path $env:TEMP ("prepforge-grok-stdout-{0}.txt" -f [Guid]::NewGuid().ToString('N'))
    $stderrPath = Join-Path $env:TEMP ("prepforge-grok-stderr-{0}.txt" -f [Guid]::NewGuid().ToString('N'))
    $process = $null
    $started = [DateTime]::UtcNow
    $timedOut = $false
    $startError = $null
    $exitCode = -1
    $output = ''

    try {
        [System.IO.File]::WriteAllText($promptFilePath, $WrappedPrompt, (New-Object System.Text.UTF8Encoding($false)))
        $argList = @(
            '--prompt-file', $promptFilePath, '--cwd', $resolvedCwd, '--model', $Model,
            '--reasoning-effort', $ReasoningEffort, '--no-memory', '--permission-mode', $permissionMode,
            '--max-turns', "$MaxTurns", '--output-format', 'plain'
        )
        if ($allowAllTools) {
            $argList += @('--always-approve', '--no-plan')
        }
        else {
            $argList += @('--no-subagents', '--tools', $readOnlyTools)
        }
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $grok.Source
        $psi.Arguments = (($argList | ForEach-Object { ConvertTo-ProcessArgument ([string]$_) }) -join ' ')
        $psi.WorkingDirectory = $resolvedCwd
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
        $psi.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $psi
        if (-not $process.Start()) { throw 'Process.Start returned false.' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSec)
        while (-not $process.HasExited) {
            if ([DateTime]::UtcNow -ge $deadline) { $timedOut = $true; Stop-ProcessTree $process; break }
            Start-Sleep -Milliseconds 100
        }
        if ($process.HasExited) { $exitCode = $process.ExitCode }
        try { $stdoutTask.Wait(1000); $stderrTask.Wait(1000) } catch {}
        $output = $stdoutTask.Result
        $stderr = $stderrTask.Result
    }
    catch {
        $startError = $_.Exception.Message
        if ([string]::IsNullOrWhiteSpace($output)) { $output = $startError }
        Stop-ProcessTree $process
    }
    finally {
        $elapsedMs = [int](([DateTime]::UtcNow - $started).TotalMilliseconds)
        try {
            $diag = @(
                "=== grok-consult $(Get-Date -Format o) ===",
                "cwd=$resolvedCwd model=$Model effort=$ReasoningEffort pid=$(if ($null -ne $process) {$process.Id} else {-1}) exit=$exitCode timeout=$timedOut elapsedMs=$elapsedMs",
                "timeoutSec=$TimeoutSec capabilityMode=$CapabilityMode permissionMode=$permissionMode maxTurns=$MaxTurns",
                '--- stdout ---', $output,
                '--- stderr ---', $stderr
            ) -join "`n"
            Set-Content -LiteralPath $OutLogPath -Value $diag -Encoding UTF8
        } catch {}
        foreach ($path in @($promptFilePath, $stdoutPath, $stderrPath)) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
        if ($null -ne $process) { $process.Dispose() }
    }

    return [pscustomobject]@{ ExitCode=$exitCode; Output=$output; TimedOut=$timedOut; StartError=$startError; ElapsedMs=$elapsedMs }
}

# Serialize concurrent consults: parallel Codex jobs racing headless Grok sessions
# previously correlated with cancelled turns and missing markers.
$lockPath = Join-Path $env:TEMP 'prepforge-grok-consult.lock'
$logPath = Join-Path $env:TEMP 'prepforge-grok-consult-last.log'
$lockStream = $null
$waited = 0
while ($null -eq $lockStream) {
    try {
        $lockStream = [System.IO.File]::Open(
            $lockPath,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
    }
    catch {
        if ($waited -ge $LockTimeoutSec) {
            throw "Timed out after ${LockTimeoutSec}s waiting for grok-consult lock at $lockPath. Another consult may be stuck; delete the lock if no grok.exe is running."
        }
        Start-Sleep -Seconds 2
        $waited += 2
    }
}

try {
    $invocationDeadline = [DateTime]::UtcNow.AddSeconds($OverallTimeoutSec)
    $attempt = 1
    $maxAttempts = 1 + [Math]::Max(0, $MaxRetries)
    $lastOutput = ''
    $lastExit = -1
    $lastTimedOut = $false
    $lastStartError = $null
    $priorSnippet = ''
    $noRetryReason = $null

    while ($attempt -le $maxAttempts) {
        $remainingSec = [int][Math]::Floor(($invocationDeadline - [DateTime]::UtcNow).TotalSeconds)
        if ($remainingSec -le 0) { break }
        $attemptTimeout = [Math]::Min($ProcessTimeoutSec, $remainingSec)
        $attemptLogPath = $logPath
        if ($KeepAttemptLogs) {
            $attemptLogPath = Join-Path $env:TEMP ("prepforge-grok-consult-attempt-{0}.log" -f $attempt)
        }

        $wrapped = New-WrappedPrompt -Task $Prompt -Attempt $attempt -PriorSnippet $priorSnippet
        $result = Invoke-GrokConsultOnce -WrappedPrompt $wrapped -OutLogPath $attemptLogPath -TimeoutSec $attemptTimeout
        $lastOutput = $result.Output
        $lastExit = $result.ExitCode
        $lastTimedOut = $result.TimedOut
        $lastStartError = $result.StartError

        # Always refresh last.log to the latest attempt for stable diagnostics path.
        if ($KeepAttemptLogs -and $attemptLogPath -ne $logPath) {
            try {
                Copy-Item -LiteralPath $attemptLogPath -Destination $logPath -Force -ErrorAction Stop
            }
            catch {
                # Best-effort mirror.
            }
        }

        $incomplete = Test-IncompleteReview -Text $lastOutput
        $looksCancelled = $lastOutput -match 'User cancelled|stop_reason.:.cancelled|session.registry|404'
        $noRetryReason = Get-NoRetryReason -Text $lastOutput -ExitCode $lastExit

        if ($lastExit -eq 0 -and -not $incomplete -and -not $lastTimedOut -and [string]::IsNullOrWhiteSpace($lastStartError)) {
            Write-ConsultResult -OutputText $lastOutput -ExitCode $lastExit -Complete $true `
                -Attempts $attempt -LogPath $logPath -NoRetryReason $null -IsError $false
            return
        }

        # Quota / auth: never burn retries probing the same blocked condition.
        if ($null -ne $noRetryReason) {
            Write-ConsultHost "[grok-consult] no-retry classification: $noRetryReason (exit=$lastExit); not retrying."
            break
        }

        if ($lastTimedOut -and $CapabilityMode -eq 'open' -and -not $AllowRetrySideEffects) {
            Write-ConsultHost '[grok-consult] open-mode process timed out; not replaying automatically because side effects may be uncertain.'
            break
        }

        $remainingAfter = [int][Math]::Floor(($invocationDeadline - [DateTime]::UtcNow).TotalSeconds)
        if ($attempt -ge $maxAttempts -or $remainingAfter -le 0) {
            break
        }

        Write-ConsultHost "[grok-consult] attempt $attempt incomplete (exit=$lastExit timeout=$lastTimedOut cancelled-ish=$looksCancelled); retrying within deadline..."
        $priorSnippet = Get-Snippet -Text $lastOutput
        $attempt++
    }

    $finalComplete = -not (Test-IncompleteReview -Text $lastOutput)

    if ($lastTimedOut) {
        Write-ConsultResult -OutputText $lastOutput -ExitCode $lastExit -Complete $false `
            -Attempts ([Math]::Min($attempt, $maxAttempts)) -LogPath $logPath -NoRetryReason 'process-timeout' -IsError $true
        throw "Grok process timed out after $ProcessTimeoutSec second(s); process tree was terminated. Log: $logPath"
    }

    if ($lastStartError) {
        Write-ConsultResult -OutputText $lastOutput -ExitCode $lastExit -Complete $false `
            -Attempts ([Math]::Min($attempt, $maxAttempts)) -LogPath $logPath -NoRetryReason 'process-start' -IsError $true
        throw "Unable to start Grok CLI: $lastStartError. Log: $logPath"
    }

    if ([DateTime]::UtcNow -ge $invocationDeadline) {
        Write-ConsultResult -OutputText $lastOutput -ExitCode $lastExit -Complete $false `
            -Attempts ([Math]::Min($attempt, $maxAttempts)) -LogPath $logPath -NoRetryReason 'overall-deadline' -IsError $true
        throw "Grok consultation exceeded the overall deadline of $OverallTimeoutSec second(s). Log: $logPath"
    }

    if ($null -ne $noRetryReason) {
        Write-ConsultResult -OutputText $lastOutput -ExitCode $lastExit -Complete $finalComplete `
            -Attempts $attempt -LogPath $logPath -NoRetryReason $noRetryReason -IsError $true
        if ($noRetryReason -eq 'quota') {
            Write-Error "Grok reported exhausted usage/quota (no-retry). Do not re-probe; use the quota fallback. Log: $logPath"
        }
        elseif ($noRetryReason -eq 'auth') {
            Write-Error "Grok authentication/login failure (no-retry). Run 'grok login' in an interactive terminal. Log: $logPath"
        }
        else {
            Write-Error "Grok failed with no-retry reason '$noRetryReason'. Log: $logPath"
        }
        exit $(if ($lastExit -ne 0) { $lastExit } else { 1 })
    }

    if ($lastExit -ne 0) {
        Write-ConsultResult -OutputText $lastOutput -ExitCode $lastExit -Complete $finalComplete `
            -Attempts $attempt -LogPath $logPath -NoRetryReason $null -IsError $true
        Write-Error "Grok exited with code $lastExit after $attempt attempt(s). Last log: $logPath"
        exit $lastExit
    }

    if ([string]::IsNullOrWhiteSpace($lastOutput)) {
        Write-ConsultResult -OutputText '' -ExitCode $lastExit -Complete $false `
            -Attempts $attempt -LogPath $logPath -NoRetryReason $null -IsError $true
        throw "Grok returned no output after $attempt attempt(s); the review is incomplete. Log: $logPath"
    }

    if (Test-IncompleteReview -Text $lastOutput) {
        Write-ConsultResult -OutputText $lastOutput -ExitCode $lastExit -Complete $false `
            -Attempts $attempt -LogPath $logPath -NoRetryReason $null -IsError $true
        throw @"
Grok exited without the completion marker '$completionMarker' after $attempt attempt(s); do not treat this response as a finished review.
Common cause: headless cancel when the model requested a non-read tool (fixed by --tools $readOnlyTools).
Diagnostic log: $logPath
"@
    }

    Write-ConsultResult -OutputText $lastOutput -ExitCode $lastExit -Complete $true `
        -Attempts $attempt -LogPath $logPath -NoRetryReason $null -IsError $false
}
finally {
    if ($null -ne $lockStream) {
        $lockStream.Close()
        $lockStream.Dispose()
    }
    # Leave the lock file in place (empty) so the next Open(OpenOrCreate) is fast;
    # exclusive share mode is what serializes, not file existence.
}
