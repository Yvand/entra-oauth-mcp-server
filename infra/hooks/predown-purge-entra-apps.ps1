<#
.SYNOPSIS
    azd "predown" hook: fully removes the Entra ID app registrations created by
    infra/entra/app-registrations.bicep (API + client apps), including purging them from
    the Entra "Deleted items" recycle bin. This exists because the Microsoft Graph Bicep
    extension does not delete app registrations on `azd down` (by design) — see README.md
    section 5 ("createEntraAppRegistrations").

.DESCRIPTION
    Gate: only runs when the azd env has CREATE_ENTRA_APP_REGISTRATIONS=true, i.e. azd
    itself created these apps. Registrations created manually via the portal/CLI scripts
    are never touched by this hook.

    Opt-out: set ENTRA_PURGE_ON_DOWN=false (azd env set ENTRA_PURGE_ON_DOWN false) to skip
    this cleanup entirely, e.g. if you want to keep or manually manage the registrations.

    This script is best-effort cleanup, not a core part of tearing down Azure resources:
    it must never fail/abort `azd down`. Every code path exits 0, and each step (resolve
    object id, soft-delete, purge) is individually guarded so one failure doesn't stop the
    rest of the cleanup.
#>

$ErrorActionPreference = 'Continue'

function Write-Log {
    param([string]$Message)
    Write-Host "[predown-purge-entra-apps] $Message"
}

function Write-Warn {
    param([string]$Message)
    Write-Warning "[predown-purge-entra-apps] $Message"
}

$results = [ordered]@{
    'API app'    = 'skipped (no app id)'
    'client app' = 'skipped (no app id)'
}

function Remove-EntraAppAndPurge {
    param(
        [string]$Label,
        [string]$AppId
    )

    if ([string]::IsNullOrWhiteSpace($AppId)) {
        Write-Log "No app id provided for $Label; nothing to purge."
        $script:results[$Label] = 'skipped (no app id)'
        return
    }

    Write-Log "Looking up object id for $Label (appId=$AppId)..."
    try {
        $objectId = (az ad app show --id $AppId --query id -o tsv 2>&1)
        $showExit = $LASTEXITCODE
    } catch {
        $objectId = $_.Exception.Message
        $showExit = 1
    }

    if ($showExit -ne 0 -or [string]::IsNullOrWhiteSpace($objectId)) {
        $errorText = [string]$objectId
        if ($errorText -match '(?i)does not exist|not found|Request_ResourceNotFound') {
            Write-Log "$Label (appId=$AppId) no longer exists; treating as already cleaned up."
            $script:results[$Label] = 'skipped (already deleted)'
            return
        }
        Write-Warn "Could not look up $Label (appId=$AppId): $errorText. Skipping cleanup for this app."
        $script:results[$Label] = 'failed (lookup error)'
        return
    }

    Write-Log "Soft-deleting $Label (appId=$AppId, objectId=$objectId)..."
    try {
        $deleteErr = (az ad app delete --id $AppId 2>&1)
        $deleteExit = $LASTEXITCODE
    } catch {
        $deleteErr = $_.Exception.Message
        $deleteExit = 1
    }
    if ($deleteExit -ne 0) {
        Write-Warn "Failed to soft-delete $Label (appId=$AppId): $deleteErr. Skipping purge for this app."
        $script:results[$Label] = 'failed (soft-delete error)'
        return
    }

    Write-Log "Purging $Label from the Entra recycle bin (objectId=$objectId)..."
    try {
        $purgeErr = (az rest --method DELETE --uri "https://graph.microsoft.com/v1.0/directory/deletedItems/$objectId" 2>&1)
        $purgeExit = $LASTEXITCODE
    } catch {
        $purgeErr = $_.Exception.Message
        $purgeExit = 1
    }
    if ($purgeExit -ne 0) {
        Write-Warn "Soft-deleted $Label but failed to purge it from the recycle bin (objectId=$objectId): $purgeErr. You may need to purge it manually in the Entra admin center."
        $script:results[$Label] = 'failed (purge error, soft-deleted only)'
        return
    }

    Write-Log "$Label fully purged (appId=$AppId)."
    $script:results[$Label] = 'purged'
}

function Main {
    if ($env:CREATE_ENTRA_APP_REGISTRATIONS -ne 'true') {
        Write-Log "CREATE_ENTRA_APP_REGISTRATIONS is not 'true'; skipping (registrations were not created by azd, or this env predates the feature)."
        exit 0
    }

    if ($env:ENTRA_PURGE_ON_DOWN -eq 'false') {
        Write-Log "ENTRA_PURGE_ON_DOWN is 'false'; skipping Entra app registration cleanup by request."
        exit 0
    }

    if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
        Write-Warn "Azure CLI ('az') not found on PATH; cannot purge Entra app registrations. Continuing with 'azd down'."
        exit 0
    }

    Remove-EntraAppAndPurge -Label 'API app' -AppId $env:ENTRA_API_APP_ID
    Remove-EntraAppAndPurge -Label 'client app' -AppId $env:ENTRA_CLIENT_APP_ID

    Write-Log "Summary:"
    foreach ($label in @('API app', 'client app')) {
        Write-Log "  - $label`: $($results[$label])"
    }

    exit 0
}

try {
    Main
} catch {
    Write-Warn "Unexpected error during Entra app registration cleanup: $($_.Exception.Message). Continuing with 'azd down'."
    exit 0
}
