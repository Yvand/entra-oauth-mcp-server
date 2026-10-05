#!/usr/bin/env bash
#
# azd "predown" hook: fully removes the Entra ID app registrations created by
# infra/entra/app-registrations.bicep (API + client apps), including purging them from
# the Entra "Deleted items" recycle bin. This exists because the Microsoft Graph Bicep
# extension does not delete app registrations on `azd down` (by design) — see README.md
# section 5 ("createEntraAppRegistrations").
#
# Gate: only runs when the azd env has CREATE_ENTRA_APP_REGISTRATIONS=true, i.e. azd
# itself created these apps. Registrations created manually via the portal/CLI scripts
# are never touched by this hook.
#
# Opt-out: set ENTRA_PURGE_ON_DOWN=false (azd env set ENTRA_PURGE_ON_DOWN false) to skip
# this cleanup entirely, e.g. if you want to keep or manually manage the registrations.
#
# This script is best-effort cleanup, not a core part of tearing down Azure resources:
# it must never fail/abort `azd down`. Every exit path below is 0, and each step
# (resolve object id, soft-delete, purge) is individually guarded so one failure doesn't
# stop the rest of the cleanup.

set -uo pipefail

log() {
  echo "[predown-purge-entra-apps] $*"
}

warn() {
  echo "[predown-purge-entra-apps] WARNING: $*" >&2
}

# Tracks outcome per app for the end-of-run summary: purged | skipped | failed
declare -A RESULTS=()

purge_app() {
  local label="$1"
  local app_id="$2"

  if [[ -z "${app_id}" ]]; then
    log "No app id provided for ${label}; nothing to purge."
    RESULTS["${label}"]="skipped (no app id)"
    return 0
  fi

  log "Looking up object id for ${label} (appId=${app_id})..."
  local show_err_file
  show_err_file=$(mktemp)
  local object_id
  object_id=$(az ad app show --id "${app_id}" --query id -o tsv 2>"${show_err_file}")
  local show_rc=$?
  local show_err
  show_err=$(cat "${show_err_file}" 2>/dev/null)
  rm -f "${show_err_file}"

  if [[ ${show_rc} -ne 0 || -z "${object_id}" ]]; then
    if echo "${show_err}" | grep -Eqi "does not exist|not found|Request_ResourceNotFound"; then
      log "${label} (appId=${app_id}) no longer exists; treating as already cleaned up."
      RESULTS["${label}"]="skipped (already deleted)"
      return 0
    fi
    warn "Could not look up ${label} (appId=${app_id}): ${show_err:-unknown error}. Skipping cleanup for this app."
    RESULTS["${label}"]="failed (lookup error)"
    return 0
  fi

  log "Soft-deleting ${label} (appId=${app_id}, objectId=${object_id})..."
  local delete_err
  delete_err=$(az ad app delete --id "${app_id}" 2>&1 >/dev/null)
  local delete_rc=$?
  if [[ ${delete_rc} -ne 0 ]]; then
    warn "Failed to soft-delete ${label} (appId=${app_id}): ${delete_err:-unknown error}. Skipping purge for this app."
    RESULTS["${label}"]="failed (soft-delete error)"
    return 0
  fi

  log "Purging ${label} from the Entra recycle bin (objectId=${object_id})..."
  local purge_err
  purge_err=$(az rest --method DELETE \
    --uri "https://graph.microsoft.com/v1.0/directory/deletedItems/${object_id}" 2>&1 >/dev/null)
  local purge_rc=$?
  if [[ ${purge_rc} -ne 0 ]]; then
    warn "Soft-deleted ${label} but failed to purge it from the recycle bin (objectId=${object_id}): ${purge_err:-unknown error}. You may need to purge it manually in the Entra admin center."
    RESULTS["${label}"]="failed (purge error, soft-deleted only)"
    return 0
  fi

  log "${label} fully purged (appId=${app_id})."
  RESULTS["${label}"]="purged"
  return 0
}

main() {
  if [[ "${CREATE_ENTRA_APP_REGISTRATIONS:-false}" != "true" ]]; then
    log "CREATE_ENTRA_APP_REGISTRATIONS is not 'true'; skipping (registrations were not created by azd, or this env predates the feature)."
    exit 0
  fi

  if [[ "${ENTRA_PURGE_ON_DOWN:-true}" == "false" ]]; then
    log "ENTRA_PURGE_ON_DOWN is 'false'; skipping Entra app registration cleanup by request."
    exit 0
  fi

  if ! command -v az >/dev/null 2>&1; then
    warn "Azure CLI ('az') not found on PATH; cannot purge Entra app registrations. Continuing with 'azd down'."
    exit 0
  fi

  purge_app "API app" "${ENTRA_API_APP_ID:-}"
  purge_app "client app" "${ENTRA_CLIENT_APP_ID:-}"

  log "Summary:"
  for label in "API app" "client app"; do
    log "  - ${label}: ${RESULTS[${label}]:-skipped (no app id)}"
  done

  exit 0
}

main
