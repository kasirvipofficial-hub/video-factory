param(
    [Parameter(Mandatory = $true)]
    [string]$YoutubeUrl,

    [string]$TenantId = 'manual-test',
    [string]$IdempotencyKey = '',
    [string]$Selection = 'all',
    [int]$DiscoveryPollSeconds = 10,
    [int]$RenderPollSeconds = 10,
    [int]$ApiReadyTimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($IdempotencyKey)) {
    $IdempotencyKey = 'manual-' + [guid]::NewGuid().ToString()
}

$apiBase = 'http://127.0.0.1:8080'
$healthUrl = "$apiBase/health"

$deadline = (Get-Date).AddSeconds($ApiReadyTimeoutSeconds)
$apiReady = $false

while ((Get-Date) -lt $deadline) {
    try {
        $health = Invoke-RestMethod -Method GET -Uri $healthUrl
        if ($health.ok) {
            $apiReady = $true
            break
        }
    } catch {
        Start-Sleep -Seconds 2
    }
}

if (-not $apiReady) {
    throw "API not ready at $healthUrl after $ApiReadyTimeoutSeconds seconds"
}

$body = @{
    youtubeUrl = $YoutubeUrl
    mode = 'auto'
    selectionPolicy = 'all'
} | ConvertTo-Json -Depth 5

$headers = @{
    'X-Tenant-Id' = $TenantId
    'X-Idempotency-Key' = $IdempotencyKey
}

$response = Invoke-RestMethod -Method POST -Uri "$apiBase/api/v1/jobs" -Headers $headers -ContentType 'application/json' -Body $body
$jobId = $response.jobId

Write-Output ("JOB_ID=" + $jobId)

function Get-JobState {
    param([string]$JobId)
    return (Invoke-RestMethod -Method GET -Uri "$apiBase/api/v1/jobs/$JobId").job
}

for ($i = 0; $i -lt 120; $i++) {
    $job = Get-JobState -JobId $jobId
    Write-Output ('[{0}] status={1} stage={2} progress={3}' -f (Get-Date -Format 'HH:mm:ss'), $job.status, $job.stage, $job.progress)

    if ($job.status -in @('awaiting_selection', 'completed', 'failed')) {
        break
    }

    Start-Sleep -Seconds $DiscoveryPollSeconds
}

$job = Get-JobState -JobId $jobId
if ($job.status -eq 'awaiting_selection') {
    $selectionBody = @{ selection = $Selection } | ConvertTo-Json -Depth 4
    Invoke-RestMethod -Method POST -Uri "$apiBase/api/v1/jobs/$jobId/selection" -ContentType 'application/json' -Body $selectionBody | Out-Null

    for ($i = 0; $i -lt 240; $i++) {
        $job = Get-JobState -JobId $jobId
        Write-Output ('[{0}] status={1} stage={2} progress={3}' -f (Get-Date -Format 'HH:mm:ss'), $job.status, $job.stage, $job.progress)

        if ($job.status -in @('completed', 'failed')) {
            break
        }

        Start-Sleep -Seconds $RenderPollSeconds
    }
}

$final = Invoke-RestMethod -Method GET -Uri "$apiBase/api/v1/jobs/$jobId"
Write-Output 'FINAL_STATUS:'
$final | ConvertTo-Json -Depth 14

if ($final.job.result.videoPath) {
    Write-Output 'FFPROBE_RESULT:'
    ffprobe -v error -show_format -show_streams $final.job.result.videoPath
}