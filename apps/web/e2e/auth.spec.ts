import { test, expect } from "@playwright/test";

test.describe("Authentication - Login Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
  });

  test("should render login page with email and password fields", async ({
    page,
  }) => {
    // Verify the page title / heading
    await expect(
      page.getByRole("heading", { name: /welcome back/i })
    ).toBeVisible();

    // Verify email input
    await expect(page.getByLabel(/email/i)).toBeVisible();

    // Verify password input
    await expect(page.getByLabel(/password/i)).toBeVisible();

    // Verify sign-in button
    await expect(
      page.getByRole("button", { name: /sign in/i })
    ).toBeVisible();
  });

  test("should show validation errors for empty submission", async ({
    page,
  }) => {
    // The HTML required attribute should prevent submission with empty fields.
    // Click the sign-in button without filling in anything.
    const emailInput = page.getByLabel(/email/i);
    const submitButton = page.getByRole("button", { name: /sign in/i });

    // Ensure the email input has the required attribute
    await expect(emailInput).toHaveAttribute("required", "");

    // Click submit and verify the browser prevents submission (the form stays on the same page)
    await submitButton.click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("should render OAuth sign-in buttons", async ({ page }) => {
    await expect(
      page.getByRole("button", { name: /google/i })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /github/i })
    ).toBeVisible();
  });

  test("should have a forgot password link", async ({ page }) => {
    const forgotLink = page.getByRole("link", {
      name: /forgot your password/i,
    });
    await expect(forgotLink).toBeVisible();
    await expect(forgotLink).toHaveAttribute("href", "/forgot-password");
  });

  test("should navigate from login to register page", async ({ page }) => {
    const signUpLink = page.getByRole("link", { name: /sign up/i });
    await expect(signUpLink).toBeVisible();

    await signUpLink.click();
    await page.waitForURL(/\/register/);
    await expect(page).toHaveURL(/\/register/);
  });

  test("should show error message for invalid credentials", async ({
    page,
  }) => {
    // Fill in invalid credentials
    await page.getByLabel(/email/i).fill("invalid@example.com");
    await page.getByLabel(/password/i).fill("wrongpassword123");

    // Submit the form
    await page.getByRole("button", { name: /sign in/i }).click();

    // Wait for the error message to appear
    await expect(page.getByText(/invalid email or password/i)).toBeVisible({
      timeout: 10000,
    });
  });
});

test.describe("Authentication - Register Page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/register");
  });

  test("should render register page with name, email, and password fields", async ({
    page,
  }) => {
    // Verify heading
    await expect(
      page.getByRole("heading", { name: /create account/i })
    ).toBeVisible();

    // Verify name input
    await expect(page.getByLabel(/full name/i)).toBeVisible();

    // Verify email input
    await expect(page.getByLabel(/email/i)).toBeVisible();

    // Verify password input
    await expect(page.getByLabel(/password/i)).toBeVisible();

    // Verify create account button
    await expect(
      page.getByRole("button", { name: /create account/i })
    ).toBeVisible();
  });

  test("should navigate from register to login page", async ({ page }) => {
    const signInLink = page.getByRole("link", { name: /sign in/i });
    await expect(signInLink).toBeVisible();

    await signInLink.click();
    await page.waitForURL(/\/login/);
    await expect(page).toHaveURL(/\/login/);
  });

  test("should render OAuth sign-up buttons", async ({ page }) => {
    await expect(
      page.getByRole("button", { name: /google/i })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /github/i })
    ).toBeVisible();
  });

  test("should enforce password minimum length", async ({ page }) => {
    const passwordInput = page.getByLabel(/password/i);
    // The register page sets minLength={8} on the password input
    await expect(passwordInput).toHaveAttribute("minlength", "8");
  });
});
