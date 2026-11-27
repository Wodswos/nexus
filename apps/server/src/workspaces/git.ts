import type { WorkspaceConfig, WorkspaceEnvironment } from '../../../../packages/core/src/executionWorkspace';
import { shellQuote as q } from '../connections';

export function repositorySource(config: WorkspaceConfig): 'local' | 'remote' | 'none' {
  if (config.source === 'local') return 'local';
  if (config.source === 'remote') return 'remote';
  return config.localRepository ? 'local' : config.repository ? 'remote' : 'none';
}
export function gitPreparationLines(environment: WorkspaceEnvironment): string[] {
  const { config } = environment, source = repositorySource(config);
  const branch = environment.branch || config.branch || `nexus-agent/workspace-${environment.id}`;
  return [
    `repository_source=${q(source)}`, `repository=${q(config.repository)}`, `local_repository=${q(config.localRepository || '')}`,
    `branch=${q(branch)}`, `base_ref=${q(config.ref)}`, `pr_target=${q(config.prTarget || config.ref || '')}`,
    'repo="$workspace_root/repo"', 'mkdir -p "$workspace_root/nexus-agent"',
    ...(source === 'none' ? ['mkdir -p "$repo"', 'branch=; base_ref=; pr_target='] : [
      'command -v git >/dev/null 2>&1 || { echo "执行环境需要安装 git" >&2; exit 1; }',
      'git check-ref-format --branch "$branch" >/dev/null',
      '[ -z "$pr_target" ] || git check-ref-format --branch "$pr_target" >/dev/null',
      'canonical_repo() { printf \'%s\' "$1" | sed -e \'s#^git@github.com:#https://github.com/#\' -e \'s#/$##\' -e \'s#\\.git$##\'; }',
      ...(source === 'local' ? [
        '[ -d "$local_repository" ] && git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$local_repository" rev-parse --git-common-dir >/dev/null 2>&1 || { echo "本地源仓库不存在或无效；不会改用远程地址" >&2; exit 1; }',
        'local_repository=$(cd "$local_repository" && pwd -P)',
        'if [ -n "$repository" ]; then actual=$(git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$local_repository" remote get-url origin 2>/dev/null || true); [ "$(canonical_repo "$actual")" = "$(canonical_repo "$repository")" ] || { echo "本地源仓库的 origin 与配置的远程仓库不一致" >&2; exit 1; }; fi',
        'source_common=$(git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$local_repository" rev-parse --path-format=absolute --git-common-dir)',
        'if [ -e "$repo/.git" ]; then',
        '  test "$(git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$repo" rev-parse --path-format=absolute --git-common-dir)" = "$source_common" || { echo "目标目录属于其他仓库" >&2; exit 1; }',
        '  test "$(git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$repo" symbolic-ref --short HEAD)" = "$branch" || { echo "目标工作区分支已变化，保留现场并停止准备" >&2; exit 1; }',
        'else',
        '  [ ! -e "$repo" ] || [ -z "$(ls -A "$repo")" ] || { echo "工作目录非空" >&2; exit 1; }',
        '  target=${base_ref:-HEAD}',
        '  target=$(git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$local_repository" rev-parse --verify --end-of-options "refs/remotes/origin/$target^{commit}" 2>/dev/null || git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$local_repository" rev-parse --verify --end-of-options "$target^{commit}")',
        '  git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$local_repository" worktree add -b "$branch" -- "$repo" "$target"',
        'fi',
        'if [ -z "$pr_target" ]; then pr_target=$(git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$local_repository" symbolic-ref --short HEAD 2>/dev/null || git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$local_repository" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true); pr_target=${pr_target#origin/}; fi',
      ] : [
        'askpass=$(mktemp)', 'trap \'rm -f "$askpass"\' EXIT',
        'printf \'%s\\n\' \'#!/bin/sh\' \'case "$1" in *sername*) printf "%s\\n" x-access-token ;; *) printf "%s\\n" "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ;; esac\' > "$askpass"',
        'chmod 700 "$askpass"', 'export GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0',
        'if [ -e "$repo/.git" ]; then',
        '  test "$(canonical_repo "$(git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$repo" remote get-url origin)")" = "$(canonical_repo "$repository")" || { echo "目标目录属于其他仓库" >&2; exit 1; }',
        '  test "$(git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$repo" symbolic-ref --short HEAD)" = "$branch" || { echo "目标工作区分支已变化，保留现场并停止准备" >&2; exit 1; }',
        'else',
        '  [ ! -e "$repo" ] || [ -z "$(ls -A "$repo")" ] || { echo "工作目录非空" >&2; exit 1; }',
        '  git -c core.fsmonitor=false -c core.hooksPath=/dev/null clone --no-checkout -- "$repository" "$repo"',
        '  target=${base_ref:-HEAD}',
        '  target=$(git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$repo" rev-parse --verify --end-of-options "refs/remotes/origin/$target^{commit}" 2>/dev/null || git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$repo" rev-parse --verify --end-of-options "$target^{commit}")',
        '  git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$repo" checkout -b "$branch" "$target"',
        'fi',
        'if [ -z "$pr_target" ]; then pr_target=$(git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$repo" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true); pr_target=${pr_target#origin/}; fi',
        'unset GIT_ASKPASS',
      ]),
      'base_ref=${base_ref:-$pr_target}',
    ]),
    'if [ -e "$repo/.git" ]; then marker="$workspace_root/.nexus-base-commit"; if [ ! -f "$marker" ]; then git -c core.fsmonitor=false -C "$repo" rev-parse HEAD > "$marker"; fi; printf \'NEXUS_BASE_COMMIT=%s\\n\' "$(cat "$marker")"; fi',
    'printf \'NEXUS_ROOT=%s\\nNEXUS_DIRECTORY=%s\\nNEXUS_SOURCE=%s\\nNEXUS_BRANCH=%s\\nNEXUS_BASE_REF=%s\\nNEXUS_PR_TARGET=%s\\n\' "$workspace_root" "$repo" "$repository_source" "$branch" "$base_ref" "$pr_target"',
  ];
}

export interface WorkspaceGitState {
  repository: boolean;
  untrackedData?: boolean;
  dirty: boolean;
  unpushed: boolean;
  trees: { directory: string; branch: string; dirtyFiles: number; unpushedCommits: number }[];
}
export function gitStatusScript(environment: WorkspaceEnvironment): string {
  return [
    'set -eu', `root=${q(environment.workRoot || environment.directory)}`, `repo=${q(environment.directory)}`,
    ...(environment.layoutVersion === 2 ? [
      'if [ -d "$root" ]; then extras=$(find "$root" -mindepth 1 -maxdepth 1 ! -name repo ! -name worktrees ! -name nexus-agent ! -name .nexus-workspace ! -name .credentials ! -name .source.git ! -name .nexus-base-commit ! -name .nexus-sessions -print -quit); [ -z "$extras" ] || printf "NEXUS_UNTRACKED_DATA\\n"; fi',
      'for trees in "$root/worktrees" "$root/nexus-agent"; do if [ ! -e "$repo/.git" ] && [ -d "$trees" ] && [ -n "$(find "$trees" -mindepth 1 -print -quit)" ]; then printf "NEXUS_UNTRACKED_DATA\\n"; fi; done',
    ] : []),
    'if [ ! -e \"$repo/.git\" ]; then if [ -d \"$repo\" ] && [ -n \"$(find \"$repo\" -mindepth 1 -maxdepth 1 -print -quit)\" ]; then printf \"NEXUS_UNTRACKED_DATA\\n\"; fi; printf \"NEXUS_NO_REPO\\n\"; exit 0; fi',
    'git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C \"$repo\" rev-parse --git-common-dir >/dev/null',
    'worktree_list=$(git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C \"$repo\" worktree list --porcelain)',
    ...(environment.layoutVersion === 2 ? [
      'for trees in "$root/worktrees" "$root/nexus-agent"; do if [ -d "$trees" ]; then find "$trees" -mindepth 1 -maxdepth 1 -print | while IFS= read -r entry; do printf "%s\\n" "$worktree_list" | grep -Fqx -- "worktree $entry" || printf "NEXUS_UNTRACKED_DATA\\n"; done; fi; done',
    ] : []),
    'printf \"%s\\n\" \"$worktree_list\" | while IFS= read -r line; do',
    '  case "$line" in "worktree "*) tree=${line#worktree } ;; *) continue ;; esac',
    '  case "$tree/" in "$root/"*) ;; *) continue ;; esac',
    '  [ "$tree" != "$root/.source.git" ] || continue',
    '  branch=$(git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$tree" symbolic-ref --short HEAD 2>/dev/null || printf detached)',
    '  changes=$(git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C \"$tree\" status --porcelain --untracked-files=all)',
    '  dirty=0; if [ -n \"$changes\" ]; then dirty=$(printf \"%s\\n\" \"$changes\" | wc -l | tr -d \" \"); fi',
    '  ahead=$(git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$tree" rev-list --count HEAD --not --remotes 2>/dev/null || printf 1)',
    '  printf \'NEXUS_TREE\\t%s\\t%s\\t%s\\t%s\\n\' "$tree" "$branch" "$dirty" "$ahead"',
    'done',
  ].join('\n');
}
export function parseGitState(output: string): WorkspaceGitState {
  const trees = output.split('\n').filter((line) => line.startsWith('NEXUS_TREE\t')).map((line) => {
    const [, directory = '', branch = '', dirty = '0', ahead = '0'] = line.split('\t');
    return { directory, branch, dirtyFiles: Number(dirty), unpushedCommits: Number(ahead) };
  });
  if (!output.includes('NEXUS_NO_REPO') && !trees.length) throw new Error('Git 工作区未返回受管工作树，不能确认数据安全');
  if (trees.some((tree) => !Number.isSafeInteger(tree.dirtyFiles) || !Number.isSafeInteger(tree.unpushedCommits))) throw new Error('Git 工作区状态无法确认');
  return { repository: !output.includes('NEXUS_NO_REPO'), untrackedData: output.includes('NEXUS_UNTRACKED_DATA'), dirty: output.includes('NEXUS_UNTRACKED_DATA') || trees.some((tree) => tree.dirtyFiles > 0), unpushed: trees.some((tree) => tree.unpushedCommits > 0), trees };
}
export function deleteWorkspaceDataScript(environment: WorkspaceEnvironment, force: boolean): string {
  if (!environment.workRoot || !environment.layoutVersion) throw new Error('旧环境没有受管目录标记，请手动核对数据');
  return [
    'set -eu', `root=${q(environment.workRoot)}`, `id=${q(environment.id)}`,
    '[ ! -L "$root" ] && [ -d "$root" ] || { echo "数据目录不存在或已被替换" >&2; exit 1; }',
    'test "$(cat "$root/.nexus-workspace")" = "$id" || { echo "目录归属不匹配" >&2; exit 1; }',
    'if [ -e "$root/repo/.git" ]; then',
    '  git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$root/repo" worktree list --porcelain | while IFS= read -r line; do',
    '    case "$line" in "worktree "*) tree=${line#worktree } ;; *) continue ;; esac',
    '    case "$tree/" in "$root/worktrees/"*|"$root/nexus-agent/"*) ;; *) continue ;; esac',
    `    git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$root/repo" worktree remove ${force ? '--force ' : ''}-- "$tree"`,
    '  done',
    ...(environment.repositorySource === 'local' ? [`  git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C ${q(environment.config.runtime === 'linux-user' ? `${environment.workRoot}/.source.git` : environment.config.localRepository || '')} worktree remove ${force ? '--force ' : ''}-- "$root/repo"${force ? ' || true' : ''}`] : []),
    'fi',
    ...(environment.config.runtime === 'linux-user' || environment.storage && ['docker-volume','pvc'].includes(environment.storage.kind) && environment.storage.mountRoot === environment.workRoot ? ['find \"$root\" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +'] : ['rm -rf -- \"$root\"']),
  ].join('\n');
}
