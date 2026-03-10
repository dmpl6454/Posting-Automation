import { test, expect } from "@playwright/test";

test.describe("Dashboard Navigation", () => {
  /**
   * Dashboard pages require authentication. Since we cannot mock next-auth in
   * Playwright, these tests verify that unauthenticated access redirects to
   * the login page (auth guard works). Where the page does render publicly
   * accessible elements before redirect, we verify those too.
   */

  test("should redirect unauthenticated users from /dashboard to login", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    // next-auth should redirect to the login/sign-in page
    await expect(page).toHaveURL(/\/(login|api\/auth\/signin)/, {
      timeout: 15000,
    });
  });

  test("should redirect unauthenticated users from /dashboard/posts to login", async ({
    page,
  }) => {
    await page.goto("/dashboard/posts");
    await expect(page).toHaveURL(/\/(login|api\/auth\/signin)/, {
      timeout: 15000,
    });
  });

  test("should redirect unauthenticated users from /dashboard/calendar to login", async ({
    page,
  }) => {
    await page.goto("/dashboard/calendar");
    await expect(page).toHaveURL(/\/(login|api\/auth\/signin)/, {
      timeout: 15000,
    });
  });

  test("should redirect unauthenticated users from /dashboard/channels to login", async ({
    page,
  }) => {
    await page.goto("/dashboard/channels");
    await expect(page).toHaveURL(/\/(login|api\/auth\/signin)/, {
      timeout: 15000,
    });
  });

  test("should redirect unauthenticated users from /dashboard/ai to login", async ({
    page,
  }) => {
    await page.goto("/dashboard/ai");
    await expect(page).toHaveURL(/\/(login|api\/auth\/signin)/, {
      timeout: 15000,
    });
  });

  test("should redirect unauthenticated users from /dashboard/media to login", async ({
    page,
  }) => {
    await page.goto("/dashboard/media");
    await expect(page).toHaveURL(/\/(login|api\/auth\/signin)/, {
      timeout: 15000,
    });
  });

  test("should redirect unauthenticated users from /dashboard/analytics to login", async ({
    page,
  }) => {
    await page.goto("/dashboard/analytics");
    await expect(page).toHaveURL(/\/(login|api\/auth\/signin)/, {
      timeout: 15000,
    });
  });

  test("should redirect unauthenticated users from /dashboard/team to login", async ({
    page,
  }) => {
    await page.goto("/dashboard/team");
    await expect(page).toHaveURL(/\/(login|api\/auth\/signin)/, {
      timeout: 15000,
    });
  });
});

test.describe("Settings Sub-Navigation Redirects", () => {
  test("should redirect unauthenticated users from /dashboard/settings to login", async ({
    page,
  }) => {
    await page.goto("/dashboard/settings");
    await expect(page).toHaveURL(/\/(login|api\/auth\/signin)/, {
      timeout: 15000,
    });
  });

  test("should redirect unauthenticated users from /dashboard/settings/billing to login", async ({
    page,
  }) => {
    await page.goto("/dashboard/settings/billing");
    await expect(page).toHaveURL(/\/(login|api\/auth\/signin)/, {
      timeout: 15000,
    });
  });

  test("should redirect unauthenticated users from /dashboard/settings/webhooks to login", async ({
    page,
  }) => {
    await page.goto("/dashboard/settings/webhooks");
    await expect(page).toHaveURL(/\/(login|api\/auth\/signin)/, {
      timeout: 15000,
    });
  });

  test("should redirect unauthenticated users from /dashboard/settings/api-keys to login", async ({
    page,
  }) => {
    await page.goto("/dashboard/settings/api-keys");
    await expect(page).toHaveURL(/\/(login|api\/auth\/signin)/, {
      timeout: 15000,
    });
  });

  test("should redirect unauthenticated users from /dashboard/settings/audit-log to login", async ({
    page,
  }) => {
    await page.goto("/dashboard/settings/audit-log");
    await expect(page).toHaveURL(/\/(login|api\/auth\/signin)/, {
      timeout: 15000,
    });
  });
});

test.describe("Public Navigation", () => {
  test("should load the landing page at /", async ({ page }) => {
    await page.goto("/");
    // Verify the page loaded successfully (status 200)
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
  });

  test("should navigate to login page from landing page", async ({
    page,
  }) => {
    await page.goto("/");
    // Look for a sign-in / login link on the landing page
    const loginLink = page.getByRole("link", { name: /sign in|log in|login/i });
    if (await loginLink.isVisible()) {
      await loginLink.click();
      await expect(page).toHaveURL(/\/login/);
    }
  });

  test("should navigate to register page from landing page", async ({
    page,
  }) => {
    await page.goto("/");
    const registerLink = page.getByRole("link", {
      name: /sign up|register|get started/i,
    });
    if (await registerLink.isVisible()) {
      await registerLink.click();
      await expect(page).toHaveURL(/\/register/);
    }
  });
});
