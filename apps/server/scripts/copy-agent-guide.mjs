import { copyFileSync, mkdirSync } from 'node:fs';

// Keep the downloadable Skill and the public guide on the same version.
const output = new URL('../dist/docs/', import.meta.url);
mkdirSync(output, { recursive: true });
copyFileSync(
  new URL('../../../docs/skills/nexus-api/SKILL.md', import.meta.url),
  new URL('agent-guide.md', output),
);
