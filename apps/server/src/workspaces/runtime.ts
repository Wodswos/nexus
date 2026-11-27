import { shellQuote as quote } from '../connections';
import { gitPreparationLines, repositorySource } from './git';
import {
  validateWorkspaceConfig,
  type WorkspaceConfig,
  type WorkspaceEnvironment,
  type WorkspacePane,
} from '../../../../packages/core/src/index';

const words = (values: string[]) => values.map(quote).join(' ');
const resourceName = (value: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value))
    throw new Error('环境标识无效');
  return value;
};
const kube = (config: WorkspaceConfig) => [
  'kubectl',
  ...(config.context ? [`--context=${config.context}`] : []),
  `--namespace=${config.namespace || 'default'}`,
];

/** Command text is generated from configuration. Prompt text travels separately on stdin. */
export function environmentCommand(
  environment: WorkspaceEnvironment,
  command: string,
  input = false,
  tty = false,
): string {
  const config = environment.config;
  if (config.runtime === 'ssh') return command;
  if (config.runtime === 'linux-user') {
    if (!environment.executionUser || !/^nx_[a-f0-9]{24}$/.test(environment.executionUser)) throw new Error('Linux Workspace 用户标识无效');
    if (!environment.executionUid || !Number.isSafeInteger(environment.executionUid)) throw new Error('Linux Workspace UID 尚未确认');
    return `test \"$(id -u ${quote(environment.executionUser)})\" = ${quote(String(environment.executionUid))} && ` + words(['sudo', '-n', '-H', '-u', environment.executionUser, '--', ...(environment.config.pidsLimit ? ['prlimit', `--nproc=${environment.config.pidsLimit}`, '--'] : []), 'sh', '-c', command]);
  }
  const resource = resourceName(environment.resourceId);
  if (config.runtime === 'docker')
    return words([
      'docker',
      'exec',
      ...(input ? ['-i'] : []),
      ...(tty ? ['-t'] : []),
      resource,
      'sh',
      '-c',
      command,
    ]);
  const execute = words([
    ...kube(config),
    'exec',
    ...(input ? ['-i'] : []),
    ...(tty ? ['-t'] : []),
    resource,
    '--',
    'sh',
    '-c',
    command,
  ]);
  if (!environment.resourceUid) return execute;
  const inspect = words([
    ...kube(config),
    'get',
    'pod',
    resource,
    '-o',
    'jsonpath={.metadata.uid}',
  ]);
  return `test "$(${inspect})" = ${quote(environment.resourceUid)} && ${execute}`;
}

const envLoader = [
  'load_env() {',
  '  [ -n "$1" ] || return 0',
  '  [ -r "$1" ] || { echo "环境凭据文件不可读" >&2; return 1; }',
  '  while IFS= read -r line || [ -n "$line" ]; do',
  '    line=${line%"$(printf "\\r")"}',
  '    case "$line" in ""|\\#*) continue ;; esac',
  '    case "$line" in *=*) ;; *) echo "环境凭据需要使用 KEY=value 格式" >&2; return 1 ;; esac',
  '    key=${line%%=*}; value=${line#*=}',
  '    case "$key" in ""|[0-9]*|*[!A-Za-z0-9_]*) echo "环境变量名无效" >&2; return 1 ;; esac',
  '    case "$value" in \\"*\\") value=${value#\\"}; value=${value%\\"} ;; \\\'*\\\') value=${value#\\\'}; value=${value%\\\'} ;; esac',
  '    export "$key=$value"',
  '  done < "$1"',
  '}',
];

/** Parse KEY=value literally; never source files containing shell syntax. */
export function loadEnvironmentScript(path: string): string {
  if (!path) return '';
  if (!path.startsWith('/') || /[\0\r\n]/.test(path)) throw new Error('环境凭据文件需要使用远端绝对路径');
  return [...envLoader, `load_env ${quote(path)}`].join('\n');
}

/** Runs inside the selected host/container/Pod after the runtime has been created. */
export function bootstrapScript(environment: WorkspaceEnvironment): string {
  const config = environment.config;
  validateWorkspaceConfig(config);
  if (environment.layoutVersion === 2) return workspaceBootstrapScript(environment);
  const host = config.runtime === 'ssh';
  const lines = [
    'set -eu',
    '# nexus:bootstrap',
    'umask 077',
    ...envLoader,
    ...(host ? [`load_env ${quote(config.secretRef)}`] : []),
    'if ! command -v tmux >/dev/null 2>&1 || { [ -n ' +
      quote(config.repository) +
      ' ] && ! command -v git >/dev/null 2>&1; }; then',
    ...(host
      ? ['  echo "控制主机需要安装 tmux，准备仓库时还需要 git" >&2; exit 1']
      : [
          '  if [ "$(id -u)" = 0 ] && command -v apk >/dev/null 2>&1; then apk add --no-cache tmux git ca-certificates;',
          '  elif [ "$(id -u)" = 0 ] && command -v apt-get >/dev/null 2>&1; then apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux git ca-certificates;',
          '  else echo "镜像需要可用的 sh、tmux 和 git，可使用预装工具的镜像" >&2; exit 1; fi',
        ]),
    'fi',
    ...(config.directory
      ? [`workdir=${quote(config.directory)}`]
      : host
        ? [
            `workdir="$HOME/.local/share/nexus/environments/${environment.id}/work"`,
          ]
        : ['workdir=/workspace']),
    'mkdir -p "$workdir"',
    `repository=${quote(config.repository)}`,
    'if [ -n "$repository" ]; then',
    '  askpass=$(mktemp)',
    '  trap \'rm -f "$askpass"\' EXIT',
    '  printf \'%s\\n\' \'#!/bin/sh\' \'case "$1" in *sername*) printf "%s\\n" x-access-token ;; *) printf "%s\\n" "${GITHUB_TOKEN:-${GH_TOKEN:-}}" ;; esac\' > "$askpass"',
    '  chmod 700 "$askpass"',
    '  export GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0',
    '  if [ -e "$workdir/.git" ]; then',
    '    [ "$(git -C "$workdir" config --get remote.origin.url)" = "$repository" ] || { echo "工作目录中已有其他仓库，请调整目录" >&2; exit 1; }',
    ...(config.ref
      ? [
          '    git -c core.hooksPath=/dev/null -C "$workdir" fetch origin --tags',
        ]
      : []),
    '  else',
    '    [ -z "$(ls -A "$workdir")" ] || { echo "仓库目录非空，请选择空目录或对应的已有仓库" >&2; exit 1; }',
    '    git -c core.hooksPath=/dev/null clone -- "$repository" "$workdir"',
    '  fi',
    ...(config.ref
      ? [
          `  revision=${quote(config.ref)}`,
          '  target=$(git -C "$workdir" rev-parse --verify --end-of-options "refs/remotes/origin/$revision^{commit}" 2>/dev/null || git -C "$workdir" rev-parse --verify --end-of-options "$revision^{commit}")',
          '  if [ "$(git -C "$workdir" rev-parse HEAD)" != "$target" ]; then',
          '    [ -z "$(git -C "$workdir" status --porcelain)" ] || { echo "现有仓库有未提交改动，请先处理改动或选择独立目录" >&2; exit 1; }',
          '    git -c core.hooksPath=/dev/null -C "$workdir" checkout --detach "$target"',
          '  fi',
        ]
      : []),
    'fi',
  ];
  const launch = [
    'set -e',
    'unset GIT_ASKPASS',
    ...envLoader,
    ...(host ? [`load_env ${quote(config.secretRef)}`] : []),
    config.agentCommand
      ? `exec sh -lc ${quote(config.agentCommand)}`
      : 'exec "${SHELL:-/bin/sh}" -l',
  ].join('\n');
  lines.push(
    `if ! tmux has-session -t ${quote('=' + environment.session)} 2>/dev/null; then`,
    `  tmux new-session -d -s ${quote(environment.session)} -c "$workdir" ${quote('sh -c ' + quote(launch))}`,
    'fi',
    'printf \'NEXUS_DIRECTORY=%s\\n\' "$workdir"',
    ...(config.repository
      ? ['printf \'NEXUS_COMMIT=%s\\n\' "$(git -C "$workdir" rev-parse HEAD)"']
      : []),
  );
  return lines.join('\n');
}

export function createRuntimeCommand(
  environment: WorkspaceEnvironment,
  userId: string,
): string | null {
  const { config } = environment;
  validateWorkspaceConfig(config);
  if (config.runtime === 'ssh') return null;
  if (config.runtime === 'linux-user') return linuxUserProvisionScript(environment);
  const name = resourceName(environment.resourceId);
  if (config.runtime === 'docker') {
    const inspect = words([
      'docker',
      'inspect',
      '--format',
      '{{index .Config.Labels "nexus.owner"}}',
      name,
    ]);
    const create = words([
      'docker',
      'run',
      '-d',
      '--name',
      name,
      '--label',
      `nexus.owner=${userId}`,
      '--label',
      `nexus.environment=${environment.id}`,
      ...(config.secretRef ? ['--env-file', config.secretRef] : []),
      ...(config.cpuLimit ? ['--cpus', config.cpuLimit] : []),
      ...(config.memoryLimit ? ['--memory', String(memoryBytes(config.memoryLimit))] : []),
      ...(config.runUser ? ['--user', config.runUser] : []),
      ...(config.pidsLimit ? ['--pids-limit', config.pidsLimit] : []),
      ...(environment.storage?.kind === 'docker-volume' ? ['--mount', `type=volume,source=${environment.storage.name},target=${environment.storage.mountRoot}`] : []),
      '--entrypoint',
      'sh',
      config.image,
      '-c',
      'while :; do sleep 3600; done',
    ]);
    return `set -eu\n# nexus:provision-docker\n${dockerVolumeProvision(environment, userId)}\nif docker inspect ${quote(name)} >/dev/null 2>&1; then test "$(${inspect})" = ${quote(userId)}; docker start ${quote(name)} >/dev/null; else ${create}; fi`;
  }
  const manifest = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: config.namespace || 'default',
      labels: { 'nexus.owner': userId, 'nexus.environment': environment.id },
    },
    spec: {
      restartPolicy: 'Never',
      ...(config.runUser ? { securityContext: { fsGroup: Number(config.runUser.split(':')[1] || config.runUser.split(':')[0]) } } : {}),
      ...(environment.storage?.kind === 'pvc' ? { volumes: [{ name: 'workspace-data', persistentVolumeClaim: { claimName: environment.storage.name } }] } : {}),
      ...(config.imagePullSecret
        ? { imagePullSecrets: [{ name: config.imagePullSecret }] }
        : {}),
      containers: [
        {
          name: 'workspace',
          image: config.image,
          ...containerConstraints(config),
          ...(environment.storage?.kind === 'pvc' ? { volumeMounts: [{ name: 'workspace-data', mountPath: environment.storage.mountRoot }] } : {}),
          command: ['sh', '-c', 'while :; do sleep 3600; done'],
          ...(config.secretRef
            ? { envFrom: [{ secretRef: { name: config.secretRef } }] }
            : {}),
        },
      ],
    },
  };
  const inspect = words([
    ...kube(config),
    'get',
    'pod',
    name,
    '-o',
    'jsonpath={.metadata.labels.nexus\\.owner}',
  ]);
  return [
    'set -eu',
    '# nexus:provision-kubernetes',
    ...kubernetesPvcProvision(environment, userId),
    `if ${words([...kube(config), 'get', 'pod', name])} >/dev/null 2>&1; then`,
    `  test "$(${inspect})" = ${quote(userId)}`,
    'else',
    `  ${words([...kube(config), 'create', '-f', '-'])} <<'NEXUS_POD_MANIFEST'`,
    JSON.stringify(manifest),
    'NEXUS_POD_MANIFEST',
    'fi',
    words([
      ...kube(config),
      'wait',
      '--for=condition=Ready',
      `pod/${name}`,
      '--timeout=180s',
    ]),
  ].join('\n');
}

export function inspectResourceCommand(
  config: WorkspaceConfig,
  resourceId: string,
): string {
  const name = resourceName(resourceId);
  if (config.runtime === 'docker') return words(['docker', 'inspect', name]);
  if (config.runtime === 'kubernetes')
    return words([...kube(config), 'get', 'pod', name, '-o', 'json']);
  throw new Error('主机环境通过 tmux 会话定位');
}

export function resourceIdentity(
  config: WorkspaceConfig,
  stdout: string,
  userId: string,
  allowStopped = false,
): { id: string; uid?: string } {
  const parsed = JSON.parse(stdout);
  if (config.runtime === 'docker') {
    const row = parsed[0];
    const owner = row?.Config?.Labels?.['nexus.owner'];
    if (!row?.Id || (owner && owner !== userId) || (!allowStopped && row.State?.Running !== true))
      throw new Error('容器不可用或归属不匹配');
    return { id: resourceName(String(row.Id)) };
  }
  const owner = parsed.metadata?.labels?.['nexus.owner'];
  if (
    !parsed.metadata?.name ||
    !parsed.metadata?.uid ||
    (owner && owner !== userId) ||
    (!allowStopped && parsed.status?.phase !== 'Running')
  )
    throw new Error('Pod 不可用或归属不匹配');
  return {
    id: resourceName(parsed.metadata.name),
    uid: String(parsed.metadata.uid),
  };
}

export function listResourcesCommand(config: WorkspaceConfig): string {
  if (config.runtime === 'docker')
    return words(['docker', 'ps', '--no-trunc', '--format', '{{json .}}']);
  if (config.runtime === 'kubernetes')
    return words([...kube(config), 'get', 'pods', '-o', 'json']);
  return "tmux list-sessions -F '#{session_name}'";
}

export const PANES_COMMAND =
  "tmux list-panes -a -F '#{pane_id}\\t#{session_id}\\t#{window_id}\\t#{pane_pid}\\t#{pid}\\t#{pane_dead}\\t#{session_name}\\t#{window_name}\\t#{pane_current_command}\\t#{pane_current_path}'";
export function parsePanes(stdout: string): WorkspacePane[] {
  return stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const parts = line.split(line.includes('\t') ? '\t' : '\\t');
      const [
        id,
        sessionId,
        windowId,
        pid,
        serverPid,
        dead,
        session,
        window,
        command,
        ...directory
      ] = parts;
      if (
        !/^%\d+$/.test(id ?? '') ||
        !/^\$\d+$/.test(sessionId ?? '') ||
        !/^@\d+$/.test(windowId ?? '') ||
        !/^\d+$/.test(pid ?? '') ||
        !/^\d+$/.test(serverPid ?? '')
      )
        return [];
      return [
        {
          id: id!,
          sessionId: sessionId!,
          windowId: windowId!,
          pid: Number(pid),
          serverPid: Number(serverPid),
          dead: dead === '1',
          session: session ?? '',
          window: window ?? '',
          command: command ?? '',
          directory: directory.join('\t'),
        },
      ];
    });
}

export function deliveryCommand(
  paneId: string,
  id: string,
  submit: boolean,
  expected?: Pick<WorkspacePane, 'pid' | 'serverPid'>,
): string {
  if (!/^%\d+$/.test(paneId) || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
    throw new Error('指令目标无效');
  const buffer = `nexus-${id}`;
  return [
    'set -eu',
    '# nexus:deliver',
    `trap ${quote(words(['tmux', 'delete-buffer', '-b', buffer]) + ' 2>/dev/null || true')} EXIT`,
    words(['tmux', 'load-buffer', '-b', buffer, '-']),
    ...(expected
      ? [
          `test "$(tmux display-message -p -t ${quote(paneId)} '#{pane_pid} #{pid}')" = ${quote(`${expected.pid} ${expected.serverPid}`)}`,
        ]
      : []),
    words(['tmux', 'paste-buffer', '-p', '-r', '-d', '-b', buffer, '-t', paneId]),
    ...(submit ? ['sleep 0.1', ...(expected ? [`test \"$(tmux display-message -p -t ${quote(paneId)} '#{pane_pid} #{pid}')\" = ${quote(`${expected.pid} ${expected.serverPid}`)}`] : []), words(['tmux', 'send-keys', '-t', paneId, 'Enter'])] : []),
  ].join('\n');
}

export function stopRuntimeCommand(environment: WorkspaceEnvironment): string {
  if (!environment.managed) throw new Error('复用环境通过解除关联结束绑定');
  if (['ssh', 'linux-user'].includes(environment.config.runtime))
    return environmentCommand(environment, environment.config.terminalPolicy==='on-demand' ? `if command -v tmux >/dev/null && tmux has-session -t ${quote('='+environment.session)} 2>/dev/null; then ${words(['tmux','kill-session','-t','='+environment.session])}; fi` : words(['tmux', 'kill-session', '-t', '=' + environment.session]));
  if (environment.config.runtime === 'docker')
    return words(['docker', 'rm', '-f', resourceName(environment.resourceId)]);
  if (!environment.resourceUid) throw new Error('Pod 缺少实例标识，请重新关联');
  const path = `/api/v1/namespaces/${encodeURIComponent(environment.config.namespace || 'default')}/pods/${encodeURIComponent(resourceName(environment.resourceId))}`;
  const remove = words([
    ...kube(environment.config),
    'delete',
    '--raw',
    path,
    '-f',
    '-',
  ]);
  return [
    `${remove} <<'NEXUS_DELETE_OPTIONS'`,
    JSON.stringify({
      apiVersion: 'v1',
      kind: 'DeleteOptions',
      preconditions: { uid: environment.resourceUid },
    }),
    'NEXUS_DELETE_OPTIONS',
  ].join('\n');
}

export function initializeWorkspaceLayout(environment: WorkspaceEnvironment): void {
  const { config } = environment;
  environment.layoutVersion = 2;
  environment.repositorySource = repositorySource(config);
  environment.branch = config.branch || (environment.repositorySource === 'none' ? '' : `nexus-agent/workspace-${environment.id}`);
  environment.baseRef = config.ref;
  environment.prTarget = config.prTarget || config.ref;
  const mountRoot = config.workRoot || config.directory || (config.runtime === 'linux-user' ? '/var/lib/nexus/workspaces' : '/workspace');
  if (config.runtime === 'linux-user') {
    environment.executionUser = `nx_${environment.id.replaceAll('-', '').slice(0, 24)}`;
    environment.workRoot = `${mountRoot.replace(/\/$/, '')}/${environment.id}/data`;
    environment.credentialFile = config.secretRef ? `${environment.workRoot}/.credentials` : undefined;
  } else if (config.runtime !== 'ssh' || config.workRoot || config.directory) environment.workRoot = `${mountRoot.replace(/\/$/, '')}/${environment.id}`;
  environment.storage = ['ssh', 'linux-user'].includes(config.runtime)
    ? { kind: 'directory', mountRoot: environment.workRoot || '', managed: true }
    : config.storage === 'ephemeral' ? { kind: 'ephemeral', mountRoot, managed: true }
      : { kind: config.runtime === 'docker' ? 'docker-volume' : 'pvc', mountRoot, name: config.volumeName || `nexus-data-${environment.id}`, managed: !config.volumeName };
}
function workspaceBootstrapScript(environment: WorkspaceEnvironment): string {
  const host = ['ssh', 'linux-user'].includes(environment.config.runtime);
  const root = environment.workRoot;
  const terminal=environment.config.terminalPolicy!=='on-demand';
  const credentials = environment.credentialFile || environment.config.secretRef;
  return [
    'set -eu', '# nexus:bootstrap', 'umask 077',
    ...(host && credentials ? [loadEnvironmentScript(credentials)] : []),
    ...(terminal ? (host ? ['command -v tmux >/dev/null 2>&1 || { echo "执行环境需要预装 tmux" >&2; exit 1; }'] : [
      'if ! command -v tmux >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then',
      '  if [ "$(id -u)" = 0 ] && command -v apk >/dev/null 2>&1; then apk add --no-cache tmux git ca-certificates;',
      '  elif [ "$(id -u)" = 0 ] && command -v apt-get >/dev/null 2>&1; then apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux git ca-certificates;',
      '  else echo "镜像需要预装 sh、tmux 和 git" >&2; exit 1; fi', 'fi',
    ]) : (repositorySource(environment.config)!=='none' ? ['command -v git >/dev/null 2>&1 || { echo "执行环境需要预装 git" >&2; exit 1; }'] : [])),
    ...(root ? [`workspace_root=${quote(root)}`] : [`workspace_root="$HOME/.local/share/nexus/workspaces/${environment.id}"`]),
    '[ ! -L "$workspace_root" ] || { echo "Workspace 根目录不能是符号链接" >&2; exit 1; }',
    'mkdir -p "$workspace_root"', 'workspace_root=$(cd "$workspace_root" && pwd -P)',
    `if [ -e "$workspace_root/.nexus-workspace" ]; then test "$(cat "$workspace_root/.nexus-workspace")" = ${quote(environment.id)}; else [ -z "$(ls -A "$workspace_root")" ] || { echo "Workspace 根目录非空且不属于此实例" >&2; exit 1; }; printf '%s' ${quote(environment.id)} > "$workspace_root/.nexus-workspace"; fi`,
    ...gitPreparationLines(environment.config.runtime === 'linux-user' && repositorySource(environment.config) === 'local'
      ? { ...environment, config: { ...environment.config, localRepository: `${environment.workRoot}/.source.git`, repository: '' } } : environment),
    ...(terminal ? [`if ! tmux has-session -t ${quote('=' + environment.session)} 2>/dev/null; then`,
    `  tmux new-session -d -s ${quote(environment.session)} -c "$repo" ${quote(environment.config.agentCommand ? 'sh -lc ' + quote(environment.config.agentCommand) : 'sh -l')}`,
    'fi'] : []),
  ].join('\n');
}
function dockerVolumeProvision(environment: WorkspaceEnvironment, userId: string): string {
  if (environment.storage?.kind !== 'docker-volume') return '';
  const name = resourceName(environment.storage.name || '');
  const inspect = words(['docker', 'volume', 'inspect', '--format', '{{index .Labels "nexus.environment"}}', name]);
  const created = words(['docker', 'volume', 'inspect', '--format', '{{.CreatedAt}}', name]);
  const provision = environment.storage.managed
    ? `if docker volume inspect ${quote(name)} >/dev/null 2>&1; then test "$(${inspect})" = ${quote(environment.id)}; else ${environment.storage.uid ? 'echo "持久卷已丢失，停止准备以免覆盖数据状态" >&2; exit 1' : words(['docker', 'volume', 'create', '--label', `nexus.owner=${userId}`, '--label', `nexus.environment=${environment.id}`, name]) + ' >/dev/null'}; fi`
    : `owner="$(${words(['docker','volume','inspect','--format','{{index .Labels "nexus.owner"}}',name])})"; [ -z "$owner" ] || [ "$owner" = '<no value>' ] || [ "$owner" = ${quote(userId)} ]`;
  const setup = environment.config.runUser ? words(['docker','run','--rm','--user','0','--mount',`type=volume,source=${name},target=${environment.storage.mountRoot}`,'--entrypoint','sh',environment.config.image,'-c',
    `set -eu; root=${quote(environment.workRoot!)}; [ ! -L "$root" ]; mkdir -p "$root"; chown ${quote(environment.config.runUser)} "$root"; chmod 700 "$root"`]) : '';
  return [provision, ...(environment.storage.uid ? [`test "$(${created})" = ${quote(environment.storage.uid)}`] : []), setup, `printf 'NEXUS_VOLUME_UID=%s\n' "$(${created})"`].filter(Boolean).join('\n');
}
export function pvcManifest(environment: WorkspaceEnvironment, userId: string) {
  return { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: environment.storage!.name, namespace: environment.config.namespace || 'default', labels: { 'nexus.owner': userId, 'nexus.environment': environment.id } }, spec: { accessModes: ['ReadWriteOnce'], ...(environment.config.storageClass ? { storageClassName: environment.config.storageClass } : {}), resources: { requests: { storage: environment.config.storageSize || '10Gi' } } } };
}
function kubernetesPvcProvision(environment: WorkspaceEnvironment, userId: string): string[] {
  if (environment.storage?.kind !== 'pvc') return [];
  const get = words([...kube(environment.config), 'get', 'pvc', environment.storage.name!]);
  const uid = `$(${get} -o ${quote('jsonpath={.metadata.uid}')})`;
  const identity = [...(environment.storage.uid ? [`test "${uid}" = ${quote(environment.storage.uid)} || { echo "PVC 已被替换，停止准备" >&2; exit 1; }`] : []), `printf 'NEXUS_PVC_UID=%s\\n' "${uid}"`];
  if (!environment.storage.managed) return [`owner="$(${get} -o ${quote('jsonpath={.metadata.labels.nexus\\.owner}')})"; [ -z "$owner" ] || [ "$owner" = ${quote(userId)} ]`, ...identity];
  return [`if ${get} >/dev/null 2>&1; then`, `  test "$(${get} -o ${quote('jsonpath={.metadata.labels.nexus\\.environment}')})" = ${quote(environment.id)}`, `  test "$(${get} -o ${quote('jsonpath={.metadata.labels.nexus\\.owner}')})" = ${quote(userId)}`, 'else', ...(environment.storage.uid ? ['echo "PVC 已丢失，停止准备以免覆盖数据状态" >&2; exit 1'] : [`  ${words([...kube(environment.config), 'create', '-f', '-'])} <<'NEXUS_PVC'`, JSON.stringify(pvcManifest(environment, userId)), 'NEXUS_PVC']), 'fi', ...identity];
}
export function linuxUserProvisionScript(environment: WorkspaceEnvironment): string {
  const user = environment.executionUser, root = environment.workRoot;
  if (!user || !/^nx_[a-f0-9]{24}$/.test(user) || !root || !root.endsWith(`/${environment.id}/data`)) throw new Error('Linux Workspace 归属信息无效');
  const home = root.slice(0, -5) + '/home', ledger = `/var/lib/nexus/managed/${environment.id}`;
  const script = [
    'set -eu', 'umask 077', '# nexus:provision-linux-user', 'test "$(id -u)" = 0',
    `for tool in useradd userdel getent sudo ${environment.config.terminalPolicy==='on-demand'?'':'tmux '}git realpath stat prlimit; do command -v "$tool" >/dev/null 2>&1 || { echo "Linux Workspace 缺少工具 $tool" >&2; exit 1; }; done`,
    `user=${quote(user)}`, `root=${quote(root)}`, `home=${quote(home)}`, `ledger=${quote(ledger)}`,
    'mkdir -p /var/lib/nexus/managed', 'chmod 700 /var/lib/nexus/managed',
    `base=${quote(root.slice(0, -(environment.id.length + 6)))}`,
    'mkdir -p \"$base\"; test \"$(realpath \"$base\")\" = \"$base\"; test \"$(stat -c %u \"$base\")\" = 0',
    'parent=\"$base\"; while [ \"$parent\" != / ]; do test \"$(stat -c %u \"$parent\")\" = 0; mode=$(stat -c %a \"$parent\"); test \"$((0$mode & 022))\" = 0 || { echo \"Linux 存储目录的祖先不能被其他用户写入\" >&2; exit 1; }; parent=$(dirname \"$parent\"); done',
    'chmod 755 \"$base\"; chmod 755 /var/lib/nexus',
    '[ ! -L "$ledger" ] && [ ! -L "$root" ] && [ ! -L "$home" ] || exit 1',
    'if id "$user" >/dev/null 2>&1; then',
    '  [ -f "$ledger" ] && [ "$(stat -c %u "$ledger")" = 0 ] || { echo "同名用户不是此实例创建，停止操作" >&2; exit 1; }',
    '  expected=$(sed -n 1p "$ledger"); test "$(id -u "$user")" = "$expected"',
    '  test "$(sed -n 2p "$ledger")" = "$root"',
    'else',
    '  [ ! -e "$ledger" ] || { echo "用户已丢失，拒绝重用旧 UID 数据" >&2; exit 1; }',
    '  [ ! -e "$home" ] && [ ! -e "$root" ] || { echo "Linux Workspace 目标目录已存在" >&2; exit 1; }',
    '  mkdir -p \"$(dirname \"$home\")\"; chmod 755 \"$(dirname \"$home\")\"',
    '  useradd --system --user-group --create-home --home-dir "$home" --shell /bin/sh "$user"',
    '  printf \'%s\\n%s\\n\' "$(id -u "$user")" "$root" > "$ledger"; chmod 600 "$ledger"',
    'fi',
    'test \"$(getent passwd \"$user\" | cut -d: -f6)\" = \"$home\"',
    'pkill -KILL -u \"$(id -u \"$user\")\" 2>/dev/null || [ \"$?\" = 1 ]',
    'mkdir -p "$root"', 'chown "$user:$user" "$root" "$home"', 'chmod 700 "$root" "$home"',
    '[ ! -L \"$root/.nexus-workspace\" ] || exit 1',
    'if [ -e \"$root/.nexus-workspace\" ]; then test \"$(stat -c %h \"$root/.nexus-workspace\")\" = 1; fi',
    `printf '%s' ${quote(environment.id)} > \"$root/.nexus-workspace\"; chown \"$user:$user\" \"$root/.nexus-workspace\"`,
    '[ ! -L \"$root/.credentials\" ] && [ ! -L \"$root/.source.git\" ] || exit 1',
    ...(environment.config.secretRef ? [`install -o "$user" -g "$user" -m 600 -- ${quote(environment.config.secretRef)} "$root/.credentials"`] : []),
    ...(repositorySource(environment.config) === 'local' ? [
      'source_copy=$1',
      '[ -d "$source_copy" ] && [ ! -L "$source_copy" ] || exit 1',
      'if [ ! -d "$root/.source.git" ]; then cp -R -- "$source_copy" "$root/.source.git"; chown -R "$user:$user" "$root/.source.git"; fi',
    ] : []),
    'printf \'NEXUS_UID=%s\\n\' "$(id -u "$user")"',
  ].join('\n');
  if (repositorySource(environment.config) === 'local') {
    const stage = [
      'set -eu', 'umask 077', `source=${quote(environment.config.localRepository || '')}`,
      // Git reads the configured source as the SSH control account, never as privileged root.
      'git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$source" rev-parse --git-common-dir >/dev/null',
      ...(environment.config.repository ? [
        'canonical_repo() { printf \'%s\' "$1" | sed -e \'s#^git@github.com:#https://github.com/#\' -e \'s#/$##\' -e \'s#\\.git$##\'; }',
        `actual=$(git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$source" remote get-url origin); test "$(canonical_repo "$actual")" = "$(canonical_repo ${quote(environment.config.repository)})" || { echo "本地源仓库与远程地址不匹配" >&2; exit 1; }`,
      ] : []),
      'staging=$(mktemp -d)', 'trap \'rm -rf -- "$staging"\' EXIT',
      'git -c core.fsmonitor=false -c core.hooksPath=/dev/null clone --bare --no-local -- "$source" "$staging/repo.git"',
      // A bare clone copies local heads only. Preserve remote-only base refs and their objects,
      // without a mirror remote or a push refspec that could affect the source repository.
      'git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$staging/repo.git" fetch --no-tags --no-write-fetch-head -- "$source" "+refs/remotes/origin/*:refs/remotes/origin/*"',
      ...(environment.config.repository ? [`git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "$staging/repo.git" remote set-url origin ${quote(environment.config.repository)}`] : []),
      `sudo -n -- sh -s -- "$staging/repo.git" <<'NEXUS_LINUX_USER'`, script, 'NEXUS_LINUX_USER',
    ];
    return stage.join('\n');
  }
  return `sudo -n -- sh -s <<'NEXUS_LINUX_USER'\n${script}\nNEXUS_LINUX_USER`;
}

export function pauseRuntimeCommand(environment: WorkspaceEnvironment): string {
  if (environment.config.runtime === 'docker') return words(['docker', 'stop', '--time', '15', resourceName(environment.resourceId)]);
  return stopRuntimeCommand(environment);
}

export function linuxUserStopCommand(environment: WorkspaceEnvironment): string {
  if (!environment.executionUser || !environment.executionUid || !environment.workRoot) throw new Error('Linux 用户身份尚未确认');
  const script = [
    'set -eu', `user=${quote(environment.executionUser)}`, `uid=${environment.executionUid}`, `ledger=${quote(`/var/lib/nexus/managed/${environment.id}`)}`,
    'test "$(stat -c %u "$ledger")" = 0', 'test "$(sed -n 1p "$ledger")" = "$uid"',
    `test "$(sed -n 2p "$ledger")" = ${quote(environment.workRoot)}`,
    'if ! id "$user" >/dev/null 2>&1; then test "$(sed -n 3p "$ledger")" = deleted; exit 0; fi',
    'test "$(id -u "$user")" = "$uid"',
    'pkill -TERM -u \"$uid\" 2>/dev/null || [ \"$?\" = 1 ]',
    'for attempt in 1 2 3 4 5; do pgrep -u \"$uid\" >/dev/null || break; sleep 0.2; done',
    'pkill -KILL -u \"$uid\" 2>/dev/null || [ \"$?\" = 1 ]',
  ].join('\n');
  return `sudo -n -- sh -s <<'NEXUS_STOP_USER'\n${script}\nNEXUS_STOP_USER`;
}
export function linuxUserRemoveCommand(environment: WorkspaceEnvironment): string {
  if (!environment.executionUser || !environment.executionUid || !environment.workRoot) throw new Error('Linux 用户身份尚未确认');
  const home = environment.workRoot.slice(0, -5) + '/home';
  const script = [
    'set -eu', `user=${quote(environment.executionUser)}`, `uid=${environment.executionUid}`, `ledger=${quote(`/var/lib/nexus/managed/${environment.id}`)}`, `home=${quote(home)}`, `root=${quote(environment.workRoot)}`,
    'test "$(stat -c %u "$ledger")" = 0', 'test "$(sed -n 1p "$ledger")" = "$uid"',
    `test "$(sed -n 2p "$ledger")" = ${quote(environment.workRoot)}`,
    'if ! id "$user" >/dev/null 2>&1; then test "$(sed -n 3p "$ledger")" = deleted; test ! -e "$home"; exit 0; fi',
    'test "$(id -u "$user")" = "$uid"',
    'test "$(getent passwd "$user" | cut -d: -f6)" = "$home"', '[ ! -L "$home" ] && { [ ! -e "$home" ] || [ "$(stat -c %u "$home")" = "$uid" ]; }',
    'pkill -KILL -u "$uid" 2>/dev/null || [ "$?" = 1 ]',
    '[ ! -L "$root" ] && { [ ! -e "$root" ] || [ "$(stat -c %u "$root")" = "$uid" ]; }',
    'if [ -e "$root" ]; then rmdir -- "$root"; fi',
    'rm -rf -- "$home"', 'userdel "$user"',
    // Retain the root-owned UID ledger as a tombstone. A missing user can never adopt old data on retry.
    'printf "deleted\n" >> "$ledger"',
  ].join('\n');
  return `sudo -n -- sh -s <<'NEXUS_DELETE_USER'\n${script}\nNEXUS_DELETE_USER`;
}

export function memoryBytes(value: string): number {
  const match = /^([1-9][0-9]*)(Mi|Gi|Ti)$/.exec(value);
  if (!match) throw new Error('Workspace 内存容量无效');
  const bytes = Number(match[1]) * ({ Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40 }[match[2]!]!);
  if (!Number.isSafeInteger(bytes)) throw new Error('Workspace 内存容量过大');
  return bytes;
}
export function containerConstraints(config: WorkspaceConfig) {
  const limits = { ...(config.cpuLimit ? { cpu: config.cpuLimit } : {}), ...(config.memoryLimit ? { memory: config.memoryLimit } : {}) };
  const [uid, gid] = (config.runUser || '').split(':');
  return { ...(Object.keys(limits).length ? { resources: { limits } } : {}), ...(uid ? { securityContext: { runAsUser: Number(uid), ...(gid ? { runAsGroup: Number(gid) } : {}) } } : {}) };
}
