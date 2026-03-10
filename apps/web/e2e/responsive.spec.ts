import { test, expect, devices } from "@playwright/test";

test.describe("Mobile Responsiveness", () => {
  // Use Pixel 5 viewport for mobile tests
  test.use({ ...devices["Pixel 5"] });

  test("should render the login page on mobile viewport", async ({
    page,
  }) => {
    await page.goto("/login");

    // Verify the login card is visible on mobile
    await expect(
      page.getByRole("heading", { name: /welcome back/i })
    ).toBeVisible();

    // Verify form fields are visible and usable
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /sign in/i })
    ).toBeVisible();
  });

  test("should render the register page on mobile viewport", async ({
    page,
  }) => {
    await page.goto("/register");

    await expect(
      page.getByRole("heading", { name: /create account/i })
    ).toBeVisible();

    // Verify all form fields are visible
    await expect(page.getByLabel(/full name/i)).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /create account/i })
    ).toBeVisible();
  });

  test("should allow login form interaction on mobile", async ({ page }) => {
    await page.goto("/login");

    // Fill in the form on mobile to verify inputs are tappable
    await page.getByLabel(/email/i).fill("test@example.com");
    await page.getByLabel(/password/i).fill("testpassword");

    // Verify the values were entered
    await expect(page.getByLabel(/email/i)).toHaveValue("test@example.com");
    await expect(page.getByLabel(/password/i)).toHaveValue("testpassword");
  });

  test("should redirect dashboard pages on mobile viewport (auth guard)", async ({
    page,
  }) => {
    // Verify that dashboard pages redirect to login even on mobile
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/(login|api\/auth\/signin)/, {
      timeout: 15000,
    });
  });

  test("should keep the login page card within mobile viewport width", async ({
    page,
  }) => {
    await page.goto("/login");

    // The login card should not overflow the viewport
    const viewportSize = page.viewportSize();
    if (viewportSize) {
      const card = page.locator('[class*="card"], [class*="Card"]').first();
      if (await card.isVisible()) {
        const boundingBox = await card.boundingBox();
        if (boundingBox) {
          expect(boundingBox.width).toBeLessThanOrEqual(viewportSize.width);
        }
      }
    }
  });

  test("should navigate between login and register on mobile", async ({
    page,
  }) => {
    await page.goto("/login");

    // Tap sign-up link
    await page.getByRole("link", { name: /sign up/i }).click();
    await page.waitForURL(/\/register/);
    await expect(page).toHaveURL(/\/register/);

    // Tap sign-in link to go back
    await page.getByRole("link", { name: /sign in/i }).click();
    await page.waitForURL(/\/login/);
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("Desktop Responsiveness", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("should render login page correctly on desktop viewport", async ({
    page,
  }) => {
    await page.goto("/login");

    await expect(
      page.getByRole("heading", { name: /welcome back/i })
    ).toBeVisible();

    // On desktop, the login card should be centered and reasonably sized
    const card = page.locator('[class*="card"], [class*="Card"]').first();
    if (await card.isVisible()) {
      const boundingBox = await card.boundingBox();
      if (boundingBox) {
        // Card should not take the full width on desktop
        expect(boundingBox.width).toBeLessThan(800);
      }
    }
  });
});
