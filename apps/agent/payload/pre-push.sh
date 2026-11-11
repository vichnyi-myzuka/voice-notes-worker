#!/bin/sh
# Агент працює в гілках `agent/<назва>` і створює PR: пуш у main чи master відхиляється. Це запобіжник від випадковості
# (системний core.hooksPath; `--no-verify` його обходить), справжній захист — правила гілок у GitHub (див. README).
while read -r _local_ref _local_sha remote_ref _remote_sha; do
	case "$remote_ref" in
		refs/heads/main | refs/heads/master)
			echo "pre-push: пуш у ${remote_ref#refs/heads/} заборонений, працюй у гілці agent/<назва> і відкривай PR." >&2
			exit 1
			;;
	esac
done
