#!/usr/bin/with-contenv bashio

# Die Optionen liest das Programm selbst aus /data/options.json
# (das App-Passwort taucht so in keiner Umgebung und keinem Protokoll auf).
export LOG_LEVEL="$(bashio::config 'log_level')"
export DATA_DIR=/data

bashio::log.info "Mailwächter startet"
cd /opt/mailwaechter
exec node app/server.js
