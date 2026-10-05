function Write-Log {
    param([string]$Message)
    Write-Host "[postdown-purge-entra-apps] $Message"
}

function Write-Warn {
    param([string]$Message)
    Write-Warning "[postdown-purge-entra-apps] $Message"
}

function Invoke-Az {
    param([string[]]$Arguments)
    try {
        $output = & az @Arguments 2>&1
        $script:AzOutput = ($output | ForEach-Object { "$_" }) -join [Environment]::NewLine
        $script:AzExitCode = $LASTEXITCODE
    }
    catch {
        $script:AzOutput = $_.Exception.Message
        $script:AzExitCode = 1
    }
}

function Test-NotFound {
    param([string]$Message)
    return $Message -match '(?i)does not exist|not found|Request_ResourceNotFound|ResourceNotFound'
}

function Test-Empty {
    param([string]$Value)
    return [string]::IsNullOrWhiteSpace($Value) -or $Value -in @('None', 'null')
}

function Get-DeletedObject {
    param(
        [string]$ObjectType,
        [string]$AppId,
        [string]$OwnershipTag
    )

    $uri = "https://graph.microsoft.com/v1.0/directory/deletedItems/microsoft.graph.${ObjectType}?%24filter=appId%20eq%20%27${AppId}%27&%24select=id,appId,tags"
    Invoke-Az -Arguments @('rest', '--method', 'GET', '--uri', $uri, '--query', 'value[0].id', '-o', 'tsv')
    if ($script:AzExitCode -ne 0) {
        if (Test-NotFound $script:AzOutput) {
            return [pscustomobject]@{ State = 'absent'; Id = '' }
        }
        return [pscustomobject]@{ State = 'error'; Id = '' }
    }

    $objectId = $script:AzOutput.Trim()
    if (Test-Empty $objectId) {
        return [pscustomobject]@{ State = 'absent'; Id = '' }
    }

    if (-not [string]::IsNullOrWhiteSpace($OwnershipTag)) {
        Invoke-Az -Arguments @('rest', '--method', 'GET', '--uri', $uri, '--query', "contains(value[0].tags, '$OwnershipTag')", '-o', 'tsv')
        if ($script:AzExitCode -ne 0 -or $script:AzOutput.Trim() -ne 'true') {
            return [pscustomobject]@{ State = 'unowned'; Id = '' }
        }
    }

    return [pscustomobject]@{ State = 'deleted'; Id = $objectId }
}

function Find-App {
    param(
        [string]$AppId,
        [string]$OwnershipTag
    )

    Invoke-Az -Arguments @('ad', 'app', 'show', '--id', $AppId, '--query', 'id', '-o', 'tsv')
    if ($script:AzExitCode -eq 0 -and -not (Test-Empty $script:AzOutput)) {
        $objectId = $script:AzOutput.Trim()
        Invoke-Az -Arguments @('ad', 'app', 'show', '--id', $AppId, '--query', "contains(tags, '$OwnershipTag')", '-o', 'tsv')
        if ($script:AzExitCode -eq 0 -and $script:AzOutput.Trim() -eq 'true') {
            return [pscustomobject]@{ State = 'active'; Id = $objectId }
        }
        return [pscustomobject]@{ State = 'unowned'; Id = '' }
    }

    if ($script:AzExitCode -eq 0 -or -not (Test-NotFound $script:AzOutput)) {
        return [pscustomobject]@{ State = 'error'; Id = '' }
    }
    return Get-DeletedObject -ObjectType 'application' -AppId $AppId -OwnershipTag $OwnershipTag
}

function Find-ServicePrincipal {
    param(
        [string]$AppId,
        [string]$OwnershipTag
    )

    Invoke-Az -Arguments @('ad', 'sp', 'show', '--id', $AppId, '--query', 'id', '-o', 'tsv')
    if ($script:AzExitCode -eq 0 -and -not (Test-Empty $script:AzOutput)) {
        $objectId = $script:AzOutput.Trim()
        Invoke-Az -Arguments @('ad', 'sp', 'show', '--id', $AppId, '--query', "contains(tags, '$OwnershipTag')", '-o', 'tsv')
        if ($script:AzExitCode -eq 0 -and $script:AzOutput.Trim() -eq 'true') {
            return [pscustomobject]@{ State = 'active'; Id = $objectId }
        }
        return [pscustomobject]@{ State = 'unowned'; Id = '' }
    }

    if ($script:AzExitCode -eq 0 -or -not (Test-NotFound $script:AzOutput)) {
        return [pscustomobject]@{ State = 'error'; Id = '' }
    }
    return Get-DeletedObject -ObjectType 'servicePrincipal' -AppId $AppId -OwnershipTag $OwnershipTag
}

function Remove-DeletedObject {
    param(
        [string]$Label,
        [string]$ObjectId
    )

    Invoke-Az -Arguments @('rest', '--method', 'DELETE', '--uri', "https://graph.microsoft.com/v1.0/directory/deletedItems/$ObjectId")
    if ($script:AzExitCode -eq 0 -or (Test-NotFound $script:AzOutput)) {
        Write-Log "$Label purged (objectId=$ObjectId)."
        return $true
    }

    Write-Warn "Failed to purge $Label (objectId=$ObjectId): $($script:AzOutput)."
    return $false
}

function Remove-EntraAppAndPurge {
    param(
        [string]$Label,
        [string]$AppId,
        [string]$OwnershipTag
    )

    if ([string]::IsNullOrWhiteSpace($AppId)) {
        Write-Log "No app id provided for $Label; nothing to purge."
        $script:Results[$Label] = 'skipped (no app id)'
        return
    }
    if ([string]::IsNullOrWhiteSpace($OwnershipTag)) {
        Write-Warn "No ownership tag provided for $Label (appId=$AppId); refusing cleanup."
        $script:Results[$Label] = 'skipped (ownership tag unavailable)'
        return
    }

    $app = Find-App -AppId $AppId -OwnershipTag $OwnershipTag
    if ($app.State -eq 'unowned') {
        Write-Warn "$Label (appId=$AppId) does not have this azd environment's ownership tag; refusing cleanup."
        $script:Results[$Label] = 'skipped (ownership mismatch)'
        return
    }
    if ($app.State -notin @('active', 'deleted', 'absent')) {
        Write-Warn "Could not verify $Label ownership or lookup state (appId=$AppId): $($script:AzOutput)."
        $script:Results[$Label] = 'failed (application lookup error)'
        return
    }

    $servicePrincipal = Find-ServicePrincipal -AppId $AppId -OwnershipTag $OwnershipTag
    if ($servicePrincipal.State -eq 'error') {
        Write-Warn "Could not look up the service principal for $Label (appId=$AppId): $($script:AzOutput)."
        $script:Results[$Label] = 'failed (service principal lookup error)'
        return
    }
    if ($servicePrincipal.State -eq 'unowned') {
        Write-Warn "The service principal for $Label (appId=$AppId) does not have this azd environment's ownership tag; refusing cleanup."
        $script:Results[$Label] = 'skipped (service principal ownership mismatch)'
        return
    }

    if ($servicePrincipal.State -eq 'active') {
        Invoke-Az -Arguments @('ad', 'sp', 'delete', '--id', $AppId)
        if ($script:AzExitCode -ne 0) {
            Write-Warn "Failed to soft-delete the service principal for $Label (appId=$AppId): $($script:AzOutput)."
            $script:Results[$Label] = 'failed (service principal delete error)'
            return
        }
    }

    if ($servicePrincipal.State -in @('active', 'deleted')) {
        if (-not (Remove-DeletedObject -Label "service principal for $Label" -ObjectId $servicePrincipal.Id)) {
            $script:Results[$Label] = 'failed (service principal purge error)'
            return
        }
    }

    if ($app.State -eq 'absent') {
        Write-Log "$Label (appId=$AppId) is already permanently deleted."
        $script:Results[$Label] = 'purged'
        return
    }

    if ($app.State -eq 'active') {
        Invoke-Az -Arguments @('ad', 'app', 'delete', '--id', $AppId)
        if ($script:AzExitCode -ne 0) {
            Write-Warn "Failed to soft-delete $Label (appId=$AppId): $($script:AzOutput)."
            $script:Results[$Label] = 'failed (application delete error)'
            return
        }
    }

    if (-not (Remove-DeletedObject -Label $Label -ObjectId $app.Id)) {
        $script:Results[$Label] = 'failed (application purge error)'
        return
    }

    $script:Results[$Label] = 'purged'
}

function Main {
    if ($env:CREATE_ENTRA_APP_REGISTRATIONS -ne 'true') {
        Write-Log "CREATE_ENTRA_APP_REGISTRATIONS is not 'true'; skipping."
        return
    }
    if ($env:ENTRA_PURGE_ON_DOWN -eq 'false') {
        Write-Log "ENTRA_PURGE_ON_DOWN is 'false'; skipping Entra cleanup by request."
        return
    }
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
        Write-Warn "Azure CLI ('az') not found on PATH; cannot purge Entra objects. Continuing with 'azd down'."
        return
    }

    $script:Results = [ordered]@{
        'API app'    = 'skipped (no app id)'
        'client app' = 'skipped (no app id)'
    }
    Remove-EntraAppAndPurge -Label 'API app' -AppId $env:ENTRA_API_APP_ID -OwnershipTag $env:ENTRA_APP_OWNERSHIP_TAG
    Remove-EntraAppAndPurge -Label 'client app' -AppId $env:ENTRA_CLIENT_APP_ID -OwnershipTag $env:ENTRA_APP_OWNERSHIP_TAG

    Write-Log "Summary:"
    foreach ($label in @('API app', 'client app')) {
        Write-Log "  - $label`: $($script:Results[$label])"
    }
}

$ErrorActionPreference = 'Continue'
$script:Results = [ordered]@{}
try {
    Main
} catch {
    Write-Warn "Unexpected error during Entra cleanup: $($_.Exception.Message). Continuing with 'azd down'."
}
exit 0
