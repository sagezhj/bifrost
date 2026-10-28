#!/usr/bin/env bash
# 同步上游更新，并列出需要补翻译的新文案
# 用法：bash ui/i18n-zh/scripts/sync-upstream.sh
set -euo pipefail

UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/maximhq/bifrost.git}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-dev}"

cd "$(git rev-parse --show-toplevel)"

if ! git remote get-url upstream >/dev/null 2>&1; then
	echo "==> 添加 upstream 远程：$UPSTREAM_URL"
	git remote add upstream "$UPSTREAM_URL"
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "zh-cn" ]; then
	echo "!! 当前分支是 $CURRENT_BRANCH，建议在 zh-cn 分支上执行"
fi

echo "==> 拉取上游 $UPSTREAM_BRANCH"
git fetch upstream "$UPSTREAM_BRANCH"

echo "==> 合并上游改动（预期只会在 ui/vite.config.mts 的 plugins 处冲突）"
if ! git merge --no-edit "upstream/$UPSTREAM_BRANCH"; then
	echo
	echo "!! 合并有冲突。汉化相关的冲突通常只有两行："
	echo "   ui/vite.config.mts  ->  import { zhI18n } ...  /  zhI18n(),"
	echo "   保留这两行即可，其余以上游为准。"
	exit 1
fi

echo
echo "==> 检查新增的未翻译文案"
node ui/i18n-zh/scripts/extract-strings.mjs --limit=80

echo
echo "==> 生成待办清单"
node ui/i18n-zh/scripts/extract-strings.mjs --todo

echo
echo "完成。把新增词条补进 ui/i18n-zh/dict/zh-CN.json 后提交即可。"

# 推送：优先用 fork 远程（你的账号），没有就退回 origin
PUSH_REMOTE="origin"
if git remote get-url fork >/dev/null 2>&1; then
	PUSH_REMOTE="fork"
fi
echo
echo "==> 推送到 $PUSH_REMOTE"
echo "   git add -A && git commit -m 'chore(i18n): 同步上游并补充词条'"
echo "   git push $PUSH_REMOTE zh-cn"
