import { shellQuote as q } from "../connections";
import type {
  AgentWorkArea,
  WorkspaceEnvironment,
} from "../../../../packages/core/src/index";

/** Only Nexus-owned children of nexus-agent can be removed, never the base repo. */
export function workAreaScript(
  area: AgentWorkArea,
  environment: WorkspaceEnvironment,
  remove = false,
): string {
  const root = environment.workRoot;
  if (
    !area.owned ||
    !root ||
    !area.directory.startsWith(root.replace(/\/$/, "") + "/nexus-agent/") ||
    area.directory === environment.directory
  )
    throw new Error("此目录不是可清理的 Nexus 独立工作目录");
  return [
    "set -eu",
    `root=${q(root)}`,
    `work=${q(area.directory)}`,
    `base=${q(environment.directory)}`,
    'test ! -L "$root" && test ! -L "$root/nexus-agent" && test ! -L "$work"',
    'test "$(realpath -m -- "$root")" = "$root"',
    'test "$(realpath -m -- "$work")" = "$work"',
    'test "$(dirname -- "$work")" = "$root/nexus-agent"',
    'if [ ! -e "$work" ]; then printf \'{"exists":false,"dirty":false,"unpushed":false}\\n\'; exit 0; fi',
    'test -d "$work" && test "$(stat -c %u -- "$work")" = "$(id -u)"',
    ...(area.kind === "worktree"
      ? [
          'test -f "$work/.git"',
          'test "$(git -C "$work" rev-parse --path-format=absolute --git-common-dir)" = "$(git -C "$base" rev-parse --path-format=absolute --git-common-dir)"',
          `test "$(git -C "$work" symbolic-ref --short HEAD)" = ${q(area.branch || "")}`,
          'changes=$(git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$work" status --porcelain --untracked-files=all)',
          'ahead=$(git -c core.fsmonitor=false -C "$work" rev-list --count HEAD --not --remotes)',
          'dirty=false; [ -z "$changes" ] || dirty=true',
          'unpushed=false; [ "$ahead" = 0 ] || unpushed=true',
        ]
      : [
          'dirty=false; [ -z "$(find "$work" -mindepth 1 -maxdepth 1 -print -quit)" ] || dirty=true',
          "unpushed=false",
        ]),
    ...(remove
      ? [
          '[ "$dirty" = false ] && [ "$unpushed" = false ] || { echo "目录有未保存数据或未推送提交，请先保存并推送后重试" >&2; exit 1; }',
          area.kind === "worktree"
            ? 'git -c core.hooksPath=/dev/null -C "$base" worktree remove -- "$work"'
            : 'rmdir -- "$work"',
        ]
      : []),
    'printf \'{"exists":true,"dirty":%s,"unpushed":%s}\\n\' "$dirty" "$unpushed"',
  ].join("\n");
}
