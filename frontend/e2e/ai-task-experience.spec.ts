import { test, expect } from "@playwright/test";

test("客服任务的商品比较与针对性追问可刷新恢复", async ({ page }) => {
  test.skip(
    process.env.E2E_AI_TASK_FIXTURE !== "1",
    "requires the isolated synthetic-provider deployment",
  );
  const headers = { "X-ShopMate-Request": "1" };
  const registered = await page.request.post("/api/auth/register", {
    headers,
    data: {
      username: `task_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
      name: "合成体验用户",
      password: "SyntheticTask123!",
    },
  });
  expect(registered.ok()).toBe(true);
  await page.goto("/support");
  await page
    .getByLabel("输入咨询内容", { exact: true })
    .fill(
      "请对比商品p01和商品p02的价格、材质和用途，说明价格取舍，不要替我下单。",
    );
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.locator(".message-assistant").last()).toContainText(
    "商品对比",
    { timeout: 20000 },
  );
  await expect(page.locator(".message-assistant").last()).toContainText(
    "价格取舍",
  );
  await page.reload();
  await expect(page.locator(".message-assistant").last()).toContainText(
    "价格取舍",
  );
  await page
    .getByLabel("输入咨询内容", { exact: true })
    .fill("我想加购商品p01，规格和数量都没选，请先问我，不要猜。");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await expect(page.locator(".message-assistant").last()).toContainText(
    "商品规格、购买数量",
    { timeout: 20000 },
  );
  await expect(page.locator(".message-assistant").last()).not.toContainText(
    "本人订单号",
  );
  await expect(page.locator(".support-proposal")).toHaveCount(0);
  await page
    .getByLabel("输入咨询内容", { exact: true })
    .fill("预算100元，推荐有货的收纳用品。");
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  const skuLink = page
    .getByRole("link", { name: "查看该规格", exact: true })
    .first();
  await expect(skuLink).toBeVisible({ timeout: 20_000 });
  const link = await skuLink.getAttribute("href");
  expect(link).toMatch(/\/products\/[^?]+\?sku=/);
  const sku = new URL(link!, page.url()).searchParams.get("sku");
  await page.getByRole("button", { name: "转人工", exact: true }).click();
  await expect(page.locator(".chat-header")).toContainText("等待人工接入");
  await skuLink.click();
  await expect(
    page.getByRole("button", { pressed: true }).filter({ hasText: /.+/ }),
  ).toHaveCount(1);
  expect(new URL(page.url()).searchParams.get("sku")).toBe(sku);
});
