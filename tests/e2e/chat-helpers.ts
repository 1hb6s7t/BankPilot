import { expect, type Page } from '@playwright/test';
import type { ConversationCommand } from '../../packages/contracts/src/conversations.js';

/** Subscribe before clicking send. Polls the saved command; never creates/retries one. */
export async function waitForConversationPlan(page: Page, timeout = 190_000): Promise<any> {
  const accepted = await page.waitForResponse(r => /\/api\/conversations\/[^/]+\/messages$/.test(r.url()) && r.request().method() === 'POST', { timeout });
  expect(accepted.status()).toBe(202);
  const { command } = await accepted.json();
  let current: ConversationCommand | undefined;
  await expect.poll(async () => {
    const response = await page.request.get(`/api/conversations/${encodeURIComponent(command.conversationId)}/commands/${encodeURIComponent(command.commandId)}`);
    expect(response.status()).toBe(200);
    current = await response.json();
    return current!.status === 'complete' || current!.status === 'failed';
  }, { timeout, intervals: [100, 250, 500, 1000] }).toBe(true);
  expect(current!.status, current!.lastErrorCode).toBe('complete');
  return current!.result;
}
