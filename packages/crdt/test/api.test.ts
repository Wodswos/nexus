import { afterEach, expect, it } from 'vitest';
import { apiRequest, configureApiTransport, setApiUserId } from '../src/api';

afterEach(() => { configureApiTransport(); setApiUserId(null); });
it('rejects a late business response from the previous account', async () => {
  let complete!: (response: { status: number; body: string }) => void;
  configureApiTransport(request => {
    expect(request.userId).toBe('account-a');
    return new Promise(resolve => { complete = resolve; });
  });
  setApiUserId('account-a');
  const pending = apiRequest('/api/servers');
  setApiUserId('account-b');
  complete({ status: 200, body: JSON.stringify([{ id: 'private-host-a' }]) });
  await expect(pending).rejects.toMatchObject({ status: 409 });
});
