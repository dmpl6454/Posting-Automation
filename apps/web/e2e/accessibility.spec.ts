import { test, expect } from "@playwright/test";

test.describe("Accessibility - Login Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
  });

  test("should have proper heading structure", async ({ page }) => {
    // There should be at least one heading on the page
    const headings = page.getByRole("heading");
    await expect(headings.first()).toBeVisible();

    // The main heading should be "Welcome Back"
    await expect(
      page.getByRole("heading", { name: /welcome back/i })
    ).toBeVisible();
  });

  test("should have form inputs with associated labels", async ({ page }) => {
    // Email input should be labelled
    const emailInput = page.getByLabel(/email/i);
    await expect(emailInput).toBeVisible();
    await expect(emailInput).toHaveAttribute("id", "email");

    // Password input should be labelled
    const passwordInput = page.getByLabel(/password/i);
    await expect(passwordInput).toBeVisible();
    await expect(passwordInput).toHaveAttribute("id", "password");

    // Verify the corresponding label elements exist with proper htmlFor
    const emailLabel = page.locator('label[for="email"]');
    await expect(emailLabel).toBeVisible();

    const passwordLabel = page.locator('label[for="password"]');
    await expect(passwordLabel).toBeVisible();
  });

  test("should have buttons with accessible names", async ({ page }) => {
    // Sign In button
    const signInButton = page.getByRole("button", { name: /sign in/i });
    await expect(signInButton).toBeVisible();

    // Google OAuth button
    const googleButton = page.getByRole("button", { name: /google/i });
    await expect(googleButton).toBeVisible();

    // GitHub OAuth button
    const githubButton = page.getByRole("button", { name: /github/i });
    await expect(githubButton).toBeVisible();
  });

  test("should have links with descriptive text", async ({ page }) => {
    // Forgot password link
    const forgotLink = page.getByRole("link", {
      name: /forgot your password/i,
    });
    await expect(forgotLink).toBeVisible();

    // Sign up link
    const signUpLink = page.getByRole("link", { name: /sign up/i });
    await expect(signUpLink).toBeVisible();
  });

  test("should support keyboard navigation on login form", async ({
    page,
  }) => {
    // Focus should be manageable via Tab key
    // Tab to email field
    await page.keyboard.press("Tab");

    // Continue tabbing through the form elements
    // We verify that focus moves through interactive elements
    const focusedTagSequence: string[] = [];

    for (let i = 0; i < 10; i++) {
      const focusedTag = await page.evaluate(() => {
        const el = document.activeElement;
        return el ? el.tagName.toLowerCase() : "none";
      });
      focusedTagSequence.push(focusedTag);
      await page.keyboard.press("Tab");
    }

    // Verify that at least some interactive elements (input, button, a) received focus
    const interactiveElements = focusedTagSequence.filter((tag) =>
      ["input", "button", "a"].includes(tag)
    );
    expect(interactiveElements.length).toBeGreaterThan(0);
  });

  test("should have proper input types for form fields", async ({ page }) => {
    // Email field should have type="email" for proper keyboard on mobile
    const emailInput = page.getByLabel(/email/i);
    await expect(emailInput).toHaveAttribute("type", "email");

    // Password field should have type="password" for security
    const passwordInput = page.getByLabel(/password/i);
    await expect(passwordInput).toHaveAttribute("type", "password");
  });
});

test.describe("Accessibility - Register Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/register");
  });

  test("should have proper heading structure", async ({ page }) => {
    await expect(
      page.getByRole("heading", { name: /create account/i })
    ).toBeVisible();
  });

  test("should have form inputs with associated labels", async ({ page }) => {
    // Name input
    const nameInput = page.getByLabel(/full name/i);
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveAttribute("id", "name");
    await expect(page.locator('label[for="name"]')).toBeVisible();

    // Email input
    const emailInput = page.getByLabel(/email/i);
    await expect(emailInput).toBeVisible();
    await expect(emailInput).toHaveAttribute("id", "email");
    await expect(page.locator('label[for="email"]')).toBeVisible();

    // Password input
    const passwordInput = page.getByLabel(/password/i);
    await expect(passwordInput).toBeVisible();
    await expect(passwordInput).toHaveAttribute("id", "password");
    await expect(page.locator('label[for="password"]')).toBeVisible();
  });

  test("should have buttons with accessible names", async ({ page }) => {
    await expect(
      page.getByRole("button", { name: /create account/i })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /google/i })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /github/i })
    ).toBeVisible();
  });

  test("should support keyboard navigation on register form", async ({
    page,
  }) => {
    // Tab through form elements and verify interactive elements receive focus
    const focusedTagSequence: string[] = [];

    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const focusedTag = await page.evaluate(() => {
        const el = document.activeElement;
        return el ? el.tagName.toLowerCase() : "none";
      });
      focusedTagSequence.push(focusedTag);
    }

    const interactiveElements = focusedTagSequence.filter((tag) =>
      ["input", "button", "a"].includes(tag)
    );
    expect(interactiveElements.length).toBeGreaterThan(0);
  });

  test("should have required attributes on mandatory fields", async ({
    page,
  }) => {
    // All registration fields should be marked as required
    await expect(page.getByLabel(/full name/i)).toHaveAttribute(
      "required",
      ""
    );
    await expect(page.getByLabel(/email/i)).toHaveAttribute("required", "");
    await expect(page.getByLabel(/password/i)).toHaveAttribute("required", "");
  });
});

test.describe("Accessibility - General", () => {
  test("should have a lang attribute on the html element", async ({
    page,
  }) => {
    await page.goto("/login");
    const lang = await page.locator("html").getAttribute("lang");
    // Next.js sets lang="en" by default
    expect(lang).toBeTruthy();
  });

  test("should have a viewport meta tag for responsive scaling", async ({
    page,
  }) => {
    await page.goto("/login");
    const viewport = page.locator('meta[name="viewport"]');
    await expect(viewport).toHaveAttribute("content", /width=device-width/);
  });
});
