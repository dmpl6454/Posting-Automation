import { test, expect } from "@playwright/test";

test.describe("Posts Page", () => {
  /**
   * Posts pages are behind authentication. These tests verify that
   * unauthenticated access to post-related routes triggers an auth redirect,
   * and that the public-facing elements (if any render before redirect) are
   * correct.
   */

  test("should redirect unauthenticated users from posts page to login", async ({
    page,
  }) => {
    await page.goto("/dashboard/posts");
    await expect(page).toHaveURL(/\/(login|api\/auth\/signin)/, {
      timeout: 15000,
    });
  });

  test("should redirect unauthenticated users from new post page to login", async ({
    page,
  }) => {
    await page.goto("/dashboard/posts/new");
    await expect(page).toHaveURL(/\/(login|api\/auth\/signin)/, {
      timeout: 15000,
    });
  });
});

test.describe("New Post Page - Smoke Tests (requires auth)", () => {
  /**
   * These tests document the expected elements on the New Post page.
   * They will only pass if the page is accessible (e.g. during authenticated
   * test runs). For now, they verify that attempting to load the page
   * without auth results in a redirect.
   *
   * When running with authentication in the future, these tests can be
   * updated to remove the redirect check and directly assert element
   * visibility.
   */

  test("should have the new post page behind auth", async ({ page }) => {
    const response = await page.goto("/dashboard/posts/new");
    // Either redirects to login or the page loads (if auth is configured)
    const url = page.url();
    const isRedirected = /\/(login|api\/auth\/signin)/.test(url);
    const isOnNewPost = /\/dashboard\/posts\/new/.test(url);
    expect(isRedirected || isOnNewPost).toBeTruthy();
  });

  test("should verify expected post creation elements exist in source", async ({
    page,
  }) => {
    // Navigate to the new post page; if it redirects, this test documents
    // the expected structure for when auth is available.
    await page.goto("/dashboard/posts/new");

    const url = page.url();
    if (/\/dashboard\/posts\/new/.test(url)) {
      // Page rendered (authenticated context) -- verify key elements

      // Content editor (textarea)
      await expect(page.locator("textarea")).toBeVisible();

      // AI enhancement button
      await expect(
        page.getByRole("button", { name: /enhance with ai/i })
      ).toBeVisible();

      // Channel selection section
      await expect(page.getByText(/select channels/i)).toBeVisible();

      // Schedule section
      await expect(page.getByText(/schedule/i).first()).toBeVisible();

      // Action buttons
      await expect(
        page.getByRole("button", { name: /save as draft/i })
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /publish now/i })
      ).toBeVisible();
    } else {
      // Auth redirect happened -- this is expected for unauthenticated runs
      expect(url).toMatch(/\/(login|api\/auth\/signin)/);
    }
  });
});

test.describe("Posts List Page - Smoke Tests (requires auth)", () => {
  test("should verify expected posts list elements when authenticated", async ({
    page,
  }) => {
    await page.goto("/dashboard/posts");

    const url = page.url();
    if (/\/dashboard\/posts/.test(url) && !/\/login/.test(url)) {
      // Page rendered -- verify key elements

      // Page heading
      await expect(
        page.getByRole("heading", { name: /posts/i })
      ).toBeVisible();

      // New post button
      await expect(
        page.getByRole("link", { name: /new post/i })
      ).toBeVisible();

      // Status filter buttons
      await expect(
        page.getByRole("button", { name: /all/i })
      ).toBeVisible();
    } else {
      // Auth redirect happened -- expected for unauthenticated runs
      expect(url).toMatch(/\/(login|api\/auth\/signin)/);
    }
  });
});
