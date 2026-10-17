import { openDatabase } from "./database";
import { createApp } from "./app";
import { createAccount } from "./auth";
import { registerSchema } from "./validation";
import { expirePendingOrders } from "./commerce";

const sql = openDatabase(process.env.DATABASE_PATH ?? "data/shopmate.sqlite");
expirePendingOrders(sql);
const expiryTimer = setInterval(() => {
  try {
    expirePendingOrders(sql);
  } catch (error) {
    console.error("订单超时处理失败", error);
  }
}, 60000);
expiryTimer.unref();
if (!sql.prepare("SELECT id FROM accounts WHERE role='admin'").get()) {
  const username = process.env.ADMIN_USERNAME ?? "admin";
  const password = process.env.ADMIN_PASSWORD;
  if (!password)
    throw new Error(
      "首次启动必须设置 ADMIN_PASSWORD（10–128 位，包含字母和数字）",
    );
  const input = registerSchema.parse({
    username,
    password,
    name: "商城管理员",
  });
  await createAccount(sql, input, "admin");
  console.log("管理员已初始化；后续重启不会覆盖账号或密码。");
}
const app = await createApp(sql, {
  origins: (
    process.env.APP_ORIGINS ??
    "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:18086,http://localhost:18086"
  ).split(","),
  secureCookies: process.env.COOKIE_SECURE === "true",
});
const server = app.listen(
  Number(process.env.PORT ?? 3001),
  process.env.HOST ?? "127.0.0.1",
  () => console.log("ShopMate API ready"),
);
function shutdown() {
  clearInterval(expiryTimer);
  server.close(() => {
    sql.close();
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
