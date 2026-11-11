import { expect, type Locator } from '@playwright/test';

/** Exercise option selection for native controls and the shared accessible select surface. */
export async function selectValue(control: Locator, value: string) {
  await expect(control).toBeVisible();
  if (await control.evaluate((element) => element.tagName === 'SELECT')) {
    await control.selectOption(value);
    return;
  }
  await control.click();
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  await control.page().locator(`[role="option"][data-value="${escaped}"]`).click();
  await expect(control.page().locator('[data-select-content]')).toHaveCount(0);
}

export async function expectSelectValue(control: Locator, value: string) {
  await expect(control).toBeVisible();
  if (await control.evaluate((element) => element.tagName === 'SELECT'))
    await expect(control).toHaveValue(value);
  else await expect(control).toHaveAttribute('data-value', value);
}

export async function selectValues(control: Locator): Promise<string[]> {
  await control.click();
  const values = await control
    .page()
    .getByRole('option')
    .evaluateAll((options) => options.map((option) => option.getAttribute('data-value')!));
  await control.page().keyboard.press('Escape');
  return values;
}
