import { test, expect } from "@playwright/test";
import { generate } from "../../backend/node_modules/otplib/dist/index.js";

const password = "BrowserUser123!";
const controlHeaders = {
  "X-Acceptance-Token": "shopmate-isolated-browser-fixture-control-token",
};
test.describe("production account browser acceptance", () => {
  test("clears the prior account's security drafts and discards its delayed export after another tab logs in", async ({
    page,
    context,
  }) => {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
    const merchant = await (await page.request.get("/api/merchant")).json();
    const headers = { "X-ShopMate-Request": "1" };
    async function register(tag: string) {
      const target = `${tag}_${suffix}@${tag}.example.test`;
      const sent = await page.request.post("/api/auth/verification/send", {
        headers,
        data: { channel: "email", target, purpose: "register" },
      });
      expect(sent.status()).toBe(202);
      const { challengeId } = await sent.json();
      const inbox = await (
        await page.request.get(
          `/__acceptance/control/inbox?target=${encodeURIComponent(target)}`,
          { headers: controlHeaders },
        )
      ).json();
      const verified = await page.request.post(
        "/api/auth/verification/verify",
        { headers, data: { challengeId, code: inbox.at(-1).code } },
      );
      expect(verified.status()).toBe(200);
      const { verificationToken } = await verified.json();
      const username = `${tag}_${suffix}`;
      const response = await page.request.post("/api/auth/register", {
        headers,
        data: {
          username,
          name: `隐私验收${tag}`,
          password,
          verificationToken,
          privacyVersion: merchant.privacy.version,
          termsVersion: merchant.terms.version,
        },
      });
      expect(response.status()).toBe(201);
      return username;
    }
    const first = await register("first"),
      second = await register("second");
    expect(
      (
        await page.request.post("/api/auth/login", {
          headers,
          data: { role: "user", username: first, password },
        })
      ).ok(),
    ).toBe(true);
    await page.goto("/account?section=security");
    await page.getByLabel("原密码", { exact: true }).fill(password);
    const panel = page.locator(".account-production-security");
    await expect(
      panel.getByText(/邮箱：.*@first\.example\.test/),
    ).toBeVisible();
    await panel
      .getByLabel("新联系方式", { exact: true })
      .fill("private-first-draft@example.test");
    await panel.getByLabel("当前密码", { exact: true }).last().fill(password);
    let release!: () => void, observed!: () => void, fulfilled!: () => void;
    const held = new Promise<void>((done) => {
      release = done;
    });
    const started = new Promise<void>((done) => {
      observed = done;
    });
    const completed = new Promise<void>((done) => {
      fulfilled = done;
    });
    await page.route("**/api/auth/export", async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      expect((await response.json()).profile.username).toBe(first);
      observed();
      await held;
      await route.fulfill({ response });
      fulfilled();
    });
    await panel
      .getByRole("button", { name: "导出本人资料", exact: true })
      .click();
    await started;
    const other = await context.newPage();
    try {
      await other.goto("/login");
      await other.getByLabel("账号", { exact: true }).fill(second);
      await other.getByLabel("密码", { exact: true }).fill(password);
      await other.getByRole("button", { name: "登录", exact: true }).click();
      await expect(other).toHaveURL(/\/$/);
      await page.bringToFront();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(
        panel.getByText(/邮箱：.*@second\.example\.test/),
      ).toBeVisible();
      await expect(panel.getByText(/@first\.example\.test/)).toHaveCount(0);
      await expect(panel.getByLabel("新联系方式", { exact: true })).toHaveValue(
        "",
      );
      await expect(
        panel.getByLabel("当前密码", { exact: true }).last(),
      ).toHaveValue("");
      await expect(page.getByLabel("原密码", { exact: true })).toHaveValue("");
      const staleDownload = page
        .waitForEvent("download", { timeout: 1_000 })
        .then(
          () => true,
          () => false,
        );
      release();
      await completed;
      expect(await staleDownload).toBe(false);
      await expect(
        panel.getByText(/邮箱：.*@second\.example\.test/),
      ).toBeVisible();
      await expect(page).toHaveURL(/\/account\?section=security$/);
    } finally {
      release();
      await other.close();
    }
  });
  test("registers a verified contact, exports personal data, recovers a password, revokes a session and closes the account", async ({
    page,
    request,
    context,
  }) => {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10),
      username = `user_${suffix}`;
    let email = `${suffix}@example.test`;
    await page.goto("/register");
    await expect(
      page.getByRole("heading", { name: "创建你的账号" }),
    ).toBeVisible();
    await page.getByLabel("账号", { exact: true }).fill("browser_owner");
    await page.getByLabel("昵称", { exact: true }).fill("验收顾客");
    await page.getByLabel("邮箱", { exact: true }).fill(email);
    await page.getByRole("button", { name: "获取验证码", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("验证码");
    const inbox = await (
      await request.get(
        `/__acceptance/control/inbox?target=${encodeURIComponent(email)}`,
        { headers: controlHeaders },
      )
    ).json();
    await page.getByLabel("验证码", { exact: true }).fill(inbox.at(-1).code);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await page.getByLabel("确认密码", { exact: true }).fill(password);
    await page
      .getByRole("checkbox", { name: "我已阅读并同意隐私政策和服务协议" })
      .check();
    await page.getByRole("button", { name: "注册并登录", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("已被注册");
    await page.getByLabel("账号", { exact: true }).fill(username);
    await page.getByRole("button", { name: "注册并登录", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    expect(
      (await context.cookies()).find(
        (cookie) => cookie.name === "shopmate_user",
      ),
    ).toMatchObject({ secure: true, httpOnly: true, sameSite: "Strict" });
    await page.goto("/account?section=security");
    await expect(
      page.getByRole("heading", { name: "已验证的联系方式" }),
    ).toBeVisible();
    await expect(page.getByText(/邮箱：.*\*\*\*@example\.test/)).toBeVisible();
    const boundEmail = `bound_${suffix}@example.test`;
    await page.getByLabel("新联系方式", { exact: true }).fill(boundEmail);
    await page.getByRole("button", { name: "获取验证码", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("验证码");
    const boundInbox = await (
      await request.get(
        `/__acceptance/control/inbox?target=${encodeURIComponent(boundEmail)}`,
        { headers: controlHeaders },
      )
    ).json();
    await page
      .getByLabel("验证码", { exact: true })
      .fill(boundInbox.at(-1).code);
    await page
      .getByLabel("当前密码", { exact: true })
      .first()
      .fill("WrongPassword123!");
    await page
      .getByRole("button", { name: "验证并绑定／更换", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("当前密码错误");
    await page.getByLabel("当前密码", { exact: true }).first().fill(password);
    await page
      .getByRole("button", { name: "验证并绑定／更换", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "联系方式已验证并保存",
    );
    email = boundEmail;
    await page.getByLabel("当前密码", { exact: true }).last().fill(password);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出本人资料" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("shopmate-personal-data.json");
    await page.getByRole("button", { name: "撤销并退出", exact: true }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.getByRole("button", { name: "忘记密码", exact: true }).click();
    await page.getByLabel("账号", { exact: true }).fill(username);
    await page.getByLabel("邮箱", { exact: true }).fill(email);
    await page.getByRole("button", { name: "获取验证码", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("六十秒");
    await request.post("/__acceptance/control/verification/advance-cooldown", {
      headers: controlHeaders,
      data: { target: email },
    });
    await page.getByRole("button", { name: "获取验证码", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("验证码");
    const recoveryInbox = await (
      await request.get(
        `/__acceptance/control/inbox?target=${encodeURIComponent(email)}`,
        { headers: controlHeaders },
      )
    ).json();
    await page
      .getByLabel("验证码", { exact: true })
      .fill(recoveryInbox.at(-1).code);
    const nextPassword = "ChangedBrowser123!";
    await page.getByLabel("新密码", { exact: true }).fill(nextPassword);
    await page.getByLabel("确认密码", { exact: true }).fill(nextPassword);
    await page.getByRole("button", { name: "重置密码", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("密码已重置");
    await page.getByLabel("账号", { exact: true }).fill(username);
    await page.getByLabel("密码", { exact: true }).fill(nextPassword);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === "/account" &&
        url.searchParams.get("section") === "security",
    );
    await expect(
      page.getByRole("heading", { name: "已验证的联系方式" }),
    ).toBeVisible();
    await page
      .getByLabel("当前密码", { exact: true })
      .last()
      .fill(nextPassword);
    await page.getByText("注销账号", { exact: true }).click();
    await page.getByLabel("请输入“注销账号”确认").fill("注销账号");
    await page.getByRole("button", { name: "确认注销", exact: true }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel("账号", { exact: true }).fill(username);
    await page.getByLabel("密码", { exact: true }).fill(nextPassword);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("账号或密码错误");
  });
  test("enrolls admin MFA, saves recovery codes and enforces second factor on a fresh browser login", async ({
    page,
    context,
  }) => {
    await page.goto("/admin/login");
    await page.getByLabel("账号", { exact: true }).fill("browser_owner");
    await page.getByLabel("密码", { exact: true }).fill("BrowserOwner123!");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "设置管理二次验证" }),
    ).toBeVisible();
    await page.getByText("无法扫描时手动输入密钥", { exact: true }).click();
    const secret = (await page.locator(".mfa-secret").textContent())!.trim();
    await page
      .getByLabel("验证码", { exact: true })
      .fill(await generate({ secret }));
    await page.getByRole("button", { name: "完成验证", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "保存恢复码" }),
    ).toBeVisible();
    const recoveryCode = (await page.locator("pre").textContent())!
      .trim()
      .split("\n")[0]!;
    await page
      .getByRole("button", { name: "我已保存恢复码，进入后台" })
      .click();
    await expect(page).toHaveURL(/\/admin$/);
    await context.clearCookies();
    await page.goto("/admin/login");
    await page.getByLabel("账号", { exact: true }).fill("browser_owner");
    await page.getByLabel("密码", { exact: true }).fill("BrowserOwner123!");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "管理二次验证", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "使用恢复码", exact: true }).click();
    await page.getByLabel("恢复码", { exact: true }).fill(recoveryCode);
    await page.getByRole("button", { name: "完成验证", exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
  });
});
