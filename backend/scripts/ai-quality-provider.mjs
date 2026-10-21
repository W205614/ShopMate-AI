/** Deterministic provider protocol double. It reads live tool results, never the evaluator's expected answers. */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const tool = (name, args) => ({ role: "assistant", content: null, tool_calls: [{ id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const final = (answer, extra = {}) => ({ role: "assistant", content: JSON.stringify({ answer, citations: [], productIds: [], ...extra }) });
export function syntheticChat(messages) {
  const lastUser = messages.findLastIndex((m) => m.role === "user" && !m.name), question = messages[lastUser]?.content ?? "";
  const toolMessages = messages.slice(lastUser + 1).filter((m) => m.role === "tool");
  const calls = messages.slice(lastUser + 1).flatMap((m) => m.tool_calls ?? []);
  const contextMessage = messages.find((m) => m.name === "server_context")?.content ?? "{}";
  let context = {};
  try { context = JSON.parse(contextMessage.slice(contextMessage.indexOf("{"))); } catch { /* No verified context. */ }
  const productId = question.match(/商品([A-Za-z0-9_-]+)/)?.[1] ?? context.product?.id;
  const skuId = question.match(/规格([A-Za-z0-9_-]+)/)?.[1] ?? context.product?.skus?.[0]?.id;
  const orderId = question.match(/订单([A-Za-z0-9_-]+)/)?.[1] ?? context.order?.id;
  if (/忽略所有规则|忽略实际来源|价格改为|输出API Key/.test(question)) return final("无法执行越权操作或泄露其他用户资料；请使用正常入口。");
  if (/还没决定|帮我申请退款|先确认具体商品规格/.test(question)) return final("请补充订单、具体商品规格、数量和原因，核对后再生成确认卡片。");
  if (/紫电量子|星海秘藏/.test(question)) return final("没有已发布的资料可以确认该商品信息，无法确认容量或保修期限，请转人工。");
  if (toolMessages.length) {
    const response = JSON.parse(toolMessages.at(-1).content), name = calls.at(-1)?.function.name;
    if (response.error) return final("订单不存在或不属于当前账号，无法查询，也不能操作。");
    if (name === "propose_action") return final("已生成待确认卡片，请核对后点击确认；确认前未执行任何业务操作。", {
      ...(response.details?.productId ? { productIds: [response.details.productId] } : {}),
      ...(response.details?.orderId ? { orderId: response.details.orderId } : {}),
    });
    if (name === "search_knowledge") {
      const sourceName = /云杉|晴岚|碧泉/.test(question) ? "quality-care.md" : "quality-policy.md";
      const sources = (response.sources ?? []).filter((s) => s.title === sourceName);
      return sources.length ? final(sources.map((s) => s.text).join("\n"), { citations: sources.map((s) => s.id) }) : final("无法从已发布资料确认，请转人工。");
    }
    if (name === "order_details") {
      const status = ({ pending: "待付款", paid: "已付款，待发货", shipped: "已发货", completed: "已收货", cancelled: "已取消" })[response.status] ?? response.status;
      return final(`订单${response.id}：${status}；应付${response.total / 100}元；创建时间${response.createdAtDisplay}。模拟物流尚未发货，无签收记录。${response.afterSales?.length ? "售后申请待审核。" : ""}`, { orderId: response.id });
    }
    if (name === "search_products") return final(response.map((p) => `${p.name}，${p.skus[0].price / 100}元`).join("；"), { productIds: response.map((p) => p.id) });
    if (name === "product_details") return final(`${response.name}，材质${response.material}；${response.skus.map((s) => `规格${s.id}价格${s.price / 100}元，可售库存${s.availableStock}件`).join("；")}`, { productIds: [response.id] });
  }
  if (/生成确认卡片/.test(question)) {
    if (/加入购物车/.test(question)) return tool("propose_action", { kind: "addCart", productId, skuId, quantity: 1 });
    if (/取消/.test(question)) return tool("propose_action", { kind: "cancelOrder", orderId });
    if (/申请售后/.test(question)) return tool("propose_action", { kind: "requestAfterSale", orderId, reason: "测试破损", description: "合成验收包装破损", lines: [{ orderItemId: question.match(/商品行([A-Za-z0-9_-]+)/)?.[1], quantity: 1 }] });
  }
  if (/合成|云杉|晴岚|碧泉/.test(question)) return tool("search_knowledge", { query: question });
  if (/预算100/.test(question)) return tool("search_products", { query: "收纳", maxPrice: 10000 });
  if (orderId) return tool("order_details", { orderId });
  if (productId) return tool("product_details", { productId });
  return final("请提供具体商品、规格或订单，以便查询。");
}

export function createSyntheticProvider() {
  return createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET" && req.url === "/health") return res.end('{"status":"ok","providerKind":"synthetic"}');
    try {
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 8 * 1024 * 1024) throw Error(); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (req.url === "/embeddings") res.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [1, 0.5, 0.25] })) }));
      else if (req.url === "/rerank") res.end(JSON.stringify({ results: body.documents.slice(0, 6).map((_, index) => ({ index, relevance_score: 1 - index / 10 })) }));
      else if (req.url === "/chat/completions") res.end(JSON.stringify({ choices: [{ message: syntheticChat(body.messages), finish_reason: "stop" }] }));
      else res.writeHead(404).end("{}");
    } catch { res.writeHead(400).end('{"code":"INVALID_SYNTHETIC_REQUEST"}'); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.env.AI_ACCEPTANCE_ALLOWED !== "1") throw Error("ISOLATED_ACCEPTANCE_AUTHORIZATION_REQUIRED");
  const port = Number(process.env.AI_QUALITY_PROVIDER_PORT ?? 18103);
  createSyntheticProvider().listen(port, process.env.AI_QUALITY_PROVIDER_HOST ?? "127.0.0.1", () => console.log(JSON.stringify({ event: "synthetic_quality_provider", port, realModelQuality: false })));
}
