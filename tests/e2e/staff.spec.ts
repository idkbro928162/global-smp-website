import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const OWNER = { email: 'owner@example.test', password: 'e2e owner passphrase' };

async function signIn(page: Page) {
  await page.goto('/staff/login');
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/staff$/);
}

test('sign-in page is accessible and rejects a wrong password', async ({ page }) => {
  await page.goto('/staff/login');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Password').fill('not the password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('The email or password is incorrect.');
});

test.describe('signed in', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  for (const path of [
    '/staff',
    '/staff/products/1',
    '/staff/docs/new',
    '/staff/users',
    '/staff/roles/3',
    '/staff/media',
    '/staff/content',
    '/staff/account',
  ]) {
    test(`no accessibility violations on ${path}`, async ({ page }) => {
      await page.goto(path);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`),
      ).toEqual([]);
    });
  }

  test('staff pages fit a phone screen', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    for (const path of [
      '/staff',
      '/staff/products',
      '/staff/products/1',
      '/staff/docs/new',
      '/staff/users',
      '/staff/audit',
      '/staff/media',
    ]) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
    await page.goto('/staff');
    await page.locator('.staff-nav-disclosure summary').click();
    await page
      .getByRole('navigation', { name: 'Staff (mobile)' })
      .getByRole('link', { name: 'Documentation' })
      .click();
    await expect(page).toHaveURL(/\/staff\/docs$/);
  });

  test('writes, previews and publishes a documentation page', async ({ page }) => {
    await page.goto('/staff/docs/new');
    await page.getByLabel('Title').fill('E2E guide');
    await page.getByLabel('URL slug').fill('e2e-guide');
    await page
      .getByLabel('Content', { exact: false })
      .first()
      .fill('## Section one\n\nHello **world**.');
    await page.getByLabel('Visibility').selectOption('published');

    await page.getByRole('button', { name: 'Preview' }).click();
    const preview = page.getByRole('region', { name: 'Preview of Content' });
    await expect(preview.locator('strong')).toHaveText('world');
    // Previewing does not save.
    expect((await page.request.get('/docs/general/e2e-guide')).status()).toBe(404);

    // Pressing Enter in a text field saves (the hidden default button), not "Preview".
    await page.getByLabel('Title').press('Enter');
    await expect(page).toHaveURL(/\/staff\/docs\/\d+\?notice=created$/);
    await expect(page.getByRole('status')).toHaveText('Created.');

    await page.goto('/docs/general/e2e-guide');
    await expect(page.getByRole('heading', { level: 1, name: 'E2E guide' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Section one' })).toBeVisible();
  });

  test('shows validation errors next to the fields and in a summary', async ({ page }) => {
    await page.goto('/staff/products/new');
    await page.getByRole('button', { name: 'Create product' }).click();
    const summary = page.getByRole('alert');
    await expect(summary).toContainText('Name: Name is required.');
    await summary.getByRole('link', { name: /Name:/ }).click();
    await expect(page).toHaveURL(/#field-name$/);
    await expect(page.locator('#field-name')).toHaveAttribute('aria-invalid', 'true');
  });

  test('signs out', async ({ page }) => {
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/staff\/login\?notice=signed-out$/);
    await page.goto('/staff');
    await expect(page).toHaveURL(/\/staff\/login\?next=%2Fstaff$/);
  });
});
