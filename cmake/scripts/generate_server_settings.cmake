# Usage: "cmake -P generate_server_settings.cmake -DESM_PREFIX=<prefix_here> -DSERVER_SETTINGS_JSON_PATH=<path_to_server_settings.json> -DOFFLINE_MODE=<true_or_false>"

# read current server-settings.json
if(EXISTS "${SERVER_SETTINGS_JSON_PATH}")
    file(READ "${SERVER_SETTINGS_JSON_PATH}" SERVER_SETTINGS_JSON)
else()
    set(SERVER_SETTINGS_JSON "{}")
    string(JSON SERVER_SETTINGS_JSON SET "${SERVER_SETTINGS_JSON}" "dataDir" "\"data\"")
    string(JSON SERVER_SETTINGS_JSON SET "${SERVER_SETTINGS_JSON}" "name" "\"My Server\"")
    set(load_order Skyrim.esm Update.esm Dawnguard.esm HearthFires.esm Dragonborn.esm)
    string(JSON SERVER_SETTINGS_JSON SET "${SERVER_SETTINGS_JSON}" "loadOrder" "[0,0,0,0,0]")
    foreach(index RANGE 0 4)
        list(GET load_order ${index} ESM)
        string(JSON SERVER_SETTINGS_JSON SET "${SERVER_SETTINGS_JSON}" "loadOrder" ${index} "\"${ESM_PREFIX}${ESM}\"")
    endforeach()
    string(JSON SERVER_SETTINGS_JSON SET "${SERVER_SETTINGS_JSON}" "npcEnabled" "false")
    string(JSON SERVER_SETTINGS_JSON SET "${SERVER_SETTINGS_JSON}" "port" "7777")
    string(JSON SERVER_SETTINGS_JSON SET "${SERVER_SETTINGS_JSON}" "maxPlayers" "100")
    string(JSON SERVER_SETTINGS_JSON SET "${SERVER_SETTINGS_JSON}" "npcSettings" "{}")
endif()

# Seed these only when they are missing, never overwrite what is already there.
#
# This runs POST_BUILD on the server target, so it fires on every single build,
# and the path it writes is routinely a symlink to a real deployment's config.
# Both branches below are wrong for a self hosted master: one blanks the field
# and the other points at the public gateway, which does not know that server's
# sessions. Rewriting them unconditionally means a rebuild silently breaks every
# login, while leaving the rest of the file untouched so it looks fine.
string(JSON offline_mode_existing ERROR_VARIABLE offline_mode_missing
       GET "${SERVER_SETTINGS_JSON}" "offlineMode")
string(JSON master_existing ERROR_VARIABLE master_missing
       GET "${SERVER_SETTINGS_JSON}" "master")

if(offline_mode_missing OR master_missing)
    if(OFFLINE_MODE)
        string(JSON SERVER_SETTINGS_JSON SET "${SERVER_SETTINGS_JSON}" "offlineMode" "true")
        string(JSON SERVER_SETTINGS_JSON SET "${SERVER_SETTINGS_JSON}" "master" "\"\"")
    else()
        string(JSON SERVER_SETTINGS_JSON SET "${SERVER_SETTINGS_JSON}" "offlineMode" "false")
        string(JSON SERVER_SETTINGS_JSON SET "${SERVER_SETTINGS_JSON}" "master" "\"https://gateway.skymp.net\"")
    endif()
endif()

file(WRITE "${SERVER_SETTINGS_JSON_PATH}" "${SERVER_SETTINGS_JSON}")

if(SERVER_SETTINGS_BASE_JSON_PATH)
  file(WRITE "${SERVER_SETTINGS_BASE_JSON_PATH}" "${SERVER_SETTINGS_JSON}")
endif()
