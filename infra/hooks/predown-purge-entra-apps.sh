#!/usr/bin/env bash

set -uo pipefail

log() {
  echo "[predown-purge-entra-apps] $*"
}

warn() {
  echo "[predown-purge-entra-apps] WARNING: $*" >&2
}

is_not_found() {
  echo "$1" | grep -Eqi "does not exist|not found|Request_ResourceNotFound|ResourceNotFound"
}

is_empty() {
  [[ -z "$1" || "$1" == "None" || "$1" == "null" ]]
}

run_az() {
  AZ_OUTPUT=$(az "$@" 2>&1)
  AZ_STATUS=$?
}

API_RESULT="skipped (no app id)"
CLIENT_RESULT="skipped (no app id)"

set_result() {
  case "$1" in
    "API app") API_RESULT="$2" ;;
    "client app") CLIENT_RESULT="$2" ;;
  esac
}

find_deleted_object() {
  local object_type="$1"
  local app_id="$2"
  local ownership_tag="$3"
  local uri="https://graph.microsoft.com/v1.0/directory/deletedItems/microsoft.graph.${object_type}?%24filter=appId%20eq%20%27${app_id}%27&%24select=id,appId,tags"

  run_az rest --method GET --uri "$uri" --query "value[0].id" -o tsv
  if [[ ${AZ_STATUS} -ne 0 ]]; then
    if is_not_found "${AZ_OUTPUT}"; then
      FOUND_ID=""
      FOUND_STATE="absent"
    else
      FOUND_ID=""
      FOUND_STATE="error"
    fi
    return 0
  fi

  local object_id="$AZ_OUTPUT"
  if is_empty "$object_id"; then
    FOUND_ID=""
    FOUND_STATE="absent"
    return 0
  fi

  if [[ -n "$ownership_tag" ]]; then
    run_az rest --method GET --uri "$uri" --query "contains(value[0].tags, '${ownership_tag}')" -o tsv
    if [[ ${AZ_STATUS} -ne 0 || "$AZ_OUTPUT" != "true" ]]; then
      FOUND_ID=""
      FOUND_STATE="unowned"
      return 0
    fi
  fi

  FOUND_ID="$object_id"
  FOUND_STATE="deleted"
}

find_app() {
  local app_id="$1"
  local ownership_tag="$2"

  run_az ad app show --id "$app_id" --query id -o tsv
  if [[ ${AZ_STATUS} -eq 0 ]] && ! is_empty "$AZ_OUTPUT"; then
    local object_id="$AZ_OUTPUT"
    run_az ad app show --id "$app_id" --query "contains(tags, '${ownership_tag}')" -o tsv
    if [[ ${AZ_STATUS} -eq 0 && "$AZ_OUTPUT" == "true" ]]; then
      FOUND_ID="$object_id"
      FOUND_STATE="active"
    else
      FOUND_ID=""
      FOUND_STATE="unowned"
    fi
    return 0
  fi

  if [[ ${AZ_STATUS} -eq 0 ]] || ! is_not_found "${AZ_OUTPUT}"; then
    FOUND_ID=""
    FOUND_STATE="error"
    return 0
  fi

  find_deleted_object "application" "$app_id" "$ownership_tag"
}

find_service_principal() {
  local app_id="$1"
  local ownership_tag="$2"

  run_az ad sp show --id "$app_id" --query id -o tsv
  if [[ ${AZ_STATUS} -eq 0 ]] && ! is_empty "$AZ_OUTPUT"; then
    local object_id="$AZ_OUTPUT"
    run_az ad sp show --id "$app_id" --query "contains(tags, '${ownership_tag}')" -o tsv
    if [[ ${AZ_STATUS} -eq 0 && "$AZ_OUTPUT" == "true" ]]; then
      FOUND_ID="$object_id"
      FOUND_STATE="active"
    else
      FOUND_ID=""
      FOUND_STATE="unowned"
    fi
    return 0
  fi

  if [[ ${AZ_STATUS} -eq 0 ]] || ! is_not_found "${AZ_OUTPUT}"; then
    FOUND_ID=""
    FOUND_STATE="error"
    return 0
  fi

  find_deleted_object "servicePrincipal" "$app_id" "$ownership_tag"
}

purge_object() {
  local label="$1"
  local object_id="$2"

  run_az rest --method DELETE --uri "https://graph.microsoft.com/v1.0/directory/deletedItems/${object_id}"
  if [[ ${AZ_STATUS} -eq 0 ]] || is_not_found "${AZ_OUTPUT}"; then
    log "${label} purged (objectId=${object_id})."
    return 0
  fi

  warn "Failed to purge ${label} (objectId=${object_id}): ${AZ_OUTPUT:-unknown error}."
  return 1
}

cleanup_app() {
  local label="$1"
  local app_id="$2"
  local ownership_tag="$3"

  if [[ -z "$app_id" ]]; then
    log "No app id provided for ${label}; nothing to purge."
    set_result "$label" "skipped (no app id)"
    return 0
  fi
  if [[ -z "$ownership_tag" ]]; then
    warn "No ownership tag provided for ${label} (appId=${app_id}); refusing cleanup."
    set_result "$label" "skipped (ownership tag unavailable)"
    return 0
  fi

  find_app "$app_id" "$ownership_tag"
  local app_object_id="$FOUND_ID"
  local app_state="$FOUND_STATE"
  if [[ "$app_state" == "unowned" ]]; then
    warn "${label} (appId=${app_id}) does not have this azd environment's ownership tag; refusing cleanup."
    set_result "$label" "skipped (ownership mismatch)"
    return 0
  elif [[ "$app_state" != "active" && "$app_state" != "deleted" && "$app_state" != "absent" ]]; then
    warn "Could not verify ${label} ownership or lookup state (appId=${app_id}): ${AZ_OUTPUT:-unknown error}."
    set_result "$label" "failed (application lookup error)"
    return 0
  fi

  find_service_principal "$app_id" "$ownership_tag"
  local sp_object_id="$FOUND_ID"
  local sp_state="$FOUND_STATE"
  if [[ "$sp_state" == "error" ]]; then
    warn "Could not look up the service principal for ${label} (appId=${app_id}): ${AZ_OUTPUT:-unknown error}."
    set_result "$label" "failed (service principal lookup error)"
    return 0
  elif [[ "$sp_state" == "unowned" ]]; then
    warn "The service principal for ${label} (appId=${app_id}) does not have this azd environment's ownership tag; refusing cleanup."
    set_result "$label" "skipped (service principal ownership mismatch)"
    return 0
  fi

  if [[ "$sp_state" == "active" ]]; then
    run_az ad sp delete --id "$app_id"
    if [[ ${AZ_STATUS} -ne 0 ]]; then
      warn "Failed to soft-delete the service principal for ${label} (appId=${app_id}): ${AZ_OUTPUT:-unknown error}."
      set_result "$label" "failed (service principal delete error)"
      return 0
    fi
  fi

  if [[ "$sp_state" == "active" || "$sp_state" == "deleted" ]]; then
    if ! purge_object "service principal for ${label}" "$sp_object_id"; then
      set_result "$label" "failed (service principal purge error)"
      return 0
    fi
  fi

  if [[ "$app_state" == "absent" ]]; then
    log "${label} (appId=${app_id}) is already permanently deleted."
    set_result "$label" "purged"
    return 0
  fi

  if [[ "$app_state" == "active" ]]; then
    run_az ad app delete --id "$app_id"
    if [[ ${AZ_STATUS} -ne 0 ]]; then
      warn "Failed to soft-delete ${label} (appId=${app_id}): ${AZ_OUTPUT:-unknown error}."
      set_result "$label" "failed (application delete error)"
      return 0
    fi
  fi

  if ! purge_object "$label" "$app_object_id"; then
    set_result "$label" "failed (application purge error)"
    return 0
  fi

  set_result "$label" "purged"
}

main() {
  if [[ "${CREATE_ENTRA_APP_REGISTRATIONS:-false}" != "true" ]]; then
    log "CREATE_ENTRA_APP_REGISTRATIONS is not 'true'; skipping."
    exit 0
  fi

  if [[ "${ENTRA_PURGE_ON_DOWN:-true}" == "false" ]]; then
    log "ENTRA_PURGE_ON_DOWN is 'false'; skipping Entra cleanup by request."
    exit 0
  fi

  if ! command -v az >/dev/null 2>&1; then
    warn "Azure CLI ('az') not found on PATH; cannot purge Entra objects. Continuing with 'azd down'."
    exit 0
  fi

  cleanup_app "API app" "${ENTRA_API_APP_ID:-}" "${ENTRA_APP_OWNERSHIP_TAG:-}"
  cleanup_app "client app" "${ENTRA_CLIENT_APP_ID:-}" "${ENTRA_APP_OWNERSHIP_TAG:-}"

  log "Summary:"
  log "  - API app: ${API_RESULT}"
  log "  - client app: ${CLIENT_RESULT}"
  exit 0
}

main
