// Прибирання сесії в контейнері: спершу видаляються сайти, які вона опублікувала (список веде publish, див. payload/publish.sh),
// далі worktree видаляється завжди, а гілка agent/* — лише якщо роботу не втрачено: її кінчик уже
// збігається з тим, що на GitHub (origin/<гілка>), або з головною гілкою (агент нічого не закомітив).
export const CLEANUP = `dir=/workspace/sessions/"$1"
list=/workspace/published/"$1"
if [ -f "$list" ]; then
	while read -r site; do
		[ -n "$site" ] && { publish --delete "$site" >&2 || echo "не вдалося видалити сайт $site" >&2; }
	done < "$list"
	rm -f "$list"
fi
if [ -e "$dir/.git" ]; then
	common=$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir)
	base="$common/.."
	branch=$(git -C "$dir" symbolic-ref --short HEAD 2>/dev/null || true)
	git -C "$base" worktree remove --force "$dir"
	case "$branch" in
	agent/*)
		tip=$(git -C "$base" rev-parse "refs/heads/$branch" 2>/dev/null || true)
		pushed=$(git -C "$base" rev-parse "refs/remotes/origin/$branch" 2>/dev/null || true)
		main=$(git -C "$base" rev-parse refs/remotes/origin/HEAD 2>/dev/null || true)
		if [ -n "$tip" ] && { [ "$tip" = "$pushed" ] || [ "$tip" = "$main" ]; }; then git -C "$base" branch -D "$branch"; fi
		;;
	esac
fi
rm -f /root/.agent/schedule/"$1".json
rm -rf "$dir"`;
