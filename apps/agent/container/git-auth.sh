# Токен GitHub лише в середовищі процесу: credential helper віддає його git за запитом. На диск (знімки) він не потрапляє,
# а в URL remote його немає, тому `git remote -v` його не друкує (на відміну від url.insteadOf).
# Підключається через `. /usr/local/lib/git-auth.sh` (entrypoint і session-prep).
if [ -n "${GITHUB_TOKEN:-}" ]; then
	export GIT_CONFIG_COUNT=1
	export GIT_CONFIG_KEY_0="credential.https://github.com.helper"
	export GIT_CONFIG_VALUE_0='!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'
fi
