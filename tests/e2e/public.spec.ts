import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const PUBLIC_PAGES = [
  '/',
  '/products',
  '/products/demo-warps',
  '/products/demo-long-name',
  '/products/demo-warps/changelog',
  '/changelog',
  '/docs',
  '/docs/demo-warps',
  '/docs/demo-warps/configuration',
  '/services',
  '/support',
  '/about',
  '/this-page-does-not-exist',
];

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe('responsive layout', () => {
  for (const width of [320, 375, 414, 768, 1024, 1440, 1920]) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const path of PUBLIC_PAGES) {
        await page.goto(path);
        expect(await horizontalOverflow(page), `${path} at ${width}px`).toBeLessThanOrEqual(0);
      }
    });
  }
});

test.describe('accessibility (axe, WCAG 2.2 AA)', () => {
  for (const path of PUBLIC_PAGES) {
    test(`no violations on ${path}`, async ({ page }) => {
      await page.goto(path);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`),
      ).toEqual([]);
    });
  }
});

test.describe('keyboard and navigation', () => {
  test('skip link is the first tab stop and moves focus to the main content', async ({ page }) => {
    await page.goto('/products');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();
  });

  test('focus is visibly indicated on links and buttons', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const outline = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const style = getComputedStyle(el);
      return `${style.outlineStyle} ${style.outlineWidth}`;
    });
    expect(outline).toBe('solid 2px');
  });

  test('mobile menu opens, closes with Escape and navigates', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/');
    const toggle = page.locator('.mobile-nav summary');
    await expect(page.getByRole('navigation', { name: 'Main', exact: true })).toBeHidden();
    // Regression: a scoped-style bug showed both icons at once.
    await expect(toggle.locator('.mobile-nav__icon-open')).toBeVisible();
    await expect(toggle.locator('.mobile-nav__icon-close')).toBeHidden();
    await toggle.click();
    const mobileNav = page.getByRole('navigation', { name: 'Main (mobile)' });
    await expect(mobileNav).toBeVisible();
    await expect(toggle.locator('.mobile-nav__icon-open')).toBeHidden();
    await expect(toggle.locator('.mobile-nav__icon-close')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(mobileNav).toBeHidden();
    await expect(toggle).toBeFocused();
    await toggle.click();
    await mobileNav.getByRole('link', { name: 'Docs' }).click();
    await expect(page).toHaveURL(/\/docs$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Documentation' })).toBeVisible();
  });

  test('product cards link to their product pages', async ({ page }) => {
    await page.goto('/products');
    await page.getByRole('link', { name: 'Demo Warps' }).first().click();
    await expect(page).toHaveURL(/\/products\/demo-warps$/);
    await expect(page.getByRole('link', { name: /Buy on BuiltByBit/ })).toHaveAttribute(
      'href',
      'https://builtbybit.com/',
    );
  });

  test('documentation pages have navigation, anchors and copyable code', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/docs/demo-warps/configuration');
    await expect(
      page.getByRole('navigation', { name: 'Demo Warps documentation' }).last(),
    ).toBeVisible();
    await expect(
      page
        .getByRole('link', { name: 'Next Commands and permissions' })
        .or(page.locator('a[rel=next]')),
    ).toBeVisible();
    // Located by class: the button's accessible name changes to "Copied" after clicking.
    const copy = page.locator('.code-block__copy').first();
    await expect(copy).toHaveText('Copy');
    await copy.click();
    await expect(copy).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('demo:');
    await page.getByRole('link', { name: 'Steps' }).last().click();
    await expect(page).toHaveURL(/#steps$/);
  });

  test('unknown pages show a helpful 404', async ({ page }) => {
    const response = await page.goto('/products/not-a-real-product');
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: /doesn’t exist/ })).toBeVisible();
  });

  test('no console errors or CSP violations on key pages', async ({ page }) => {
    const problems: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') problems.push(msg.text());
    });
    page.on('pageerror', (error) => problems.push(error.message));
    for (const path of [
      '/',
      '/products/demo-warps',
      '/docs/demo-warps/configuration',
      '/staff/login',
    ]) {
      await page.goto(path);
    }
    expect(problems).toEqual([]);
  });
});
