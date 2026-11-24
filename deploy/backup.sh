#!/bin/bash
set -euo pipefail
umask 077
cd /home/crew
mkdir -p backups
tmp=$(mktemp backups/.crew-XXXXXX)
trap 'rm -f "$tmp"' EXIT
sqlite3 -readonly -cmd '.timeout 10000' .crew/crew.db ".backup '$tmp'"
sqlite3 "$tmp" 'PRAGMA journal_mode=DELETE;' >/dev/null
check=$(sqlite3 -readonly "$tmp" 'PRAGMA quick_check;')
[[ $check == ok ]]
mv "$tmp" "backups/crew-$(date +%F).db"
find backups -maxdepth 1 -type f -name 'crew-????-??-??.db' -mtime +13 -delete
