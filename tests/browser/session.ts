import { expect, type Page } from "@playwright/test";

export const PASSWORD = "correct horse battery staple";
export const signIn = async (page: Page): Promise<void> => {
  await page.goto("/web/");
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
};
