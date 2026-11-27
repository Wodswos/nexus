import { shellQuote as q } from '../connections';

/** Use the execution user's existing NVM default only when PATH lacks the command.
 * No install, shell-profile edits, node-version switch or credentials are involved.
 */
export function agentRuntimeSetup(executable: string): string {
  return [
    `if ! command -v ${q(executable)} >/dev/null 2>&1; then`,
    '  nexus_nvm_dir=${NVM_DIR:-${HOME:-}/.nvm}',
    '  if [ -n "${HOME:-}" ] && [ -s "$nexus_nvm_dir/nvm.sh" ]; then',
    '    export NVM_DIR="$nexus_nvm_dir"',
    '    if . "$NVM_DIR/nvm.sh" --no-use >/dev/null 2>&1; then',
    '      nexus_node=$(nvm which default 2>/dev/null) || nexus_node=',
    '      case "$nexus_node" in /*/node) if [ -x "$nexus_node" ]; then PATH="${nexus_node%/node}:$PATH"; export PATH; fi ;; esac',
    '    fi',
    '  fi',
    '  unset nexus_nvm_dir nexus_node',
    'fi',
  ].join('\n');
}

export function agentLoginCommand(command: string): string {
  // Complex commands retain their shell semantics; only a literal command name
  // can safely determine whether a fallback PATH is needed.
  const executable = /^([A-Za-z0-9_.+-]+)(?:\s|$)/.exec(command.trim())?.[1];
  const setup = executable ? agentRuntimeSetup(executable) + '\n' : '';
  return `sh -lc ${q(setup + command)}`;
}
