import { z } from "zod";

export const answerPresentationSchema = z
  .object({
    productView: z.enum(["details", "compare", "recommend"]).optional(),
    focus: z
      .array(z.enum(["description", "material", "price", "stock"]))
      .min(1)
      .max(4)
      .optional(),
    missingFields: z
      .array(z.enum(["product", "sku", "quantity", "order", "reason", "items"]))
      .min(1)
      .max(6)
      .optional(),
    sourceQuotes: z
      .array(
        z
          .object({
            sourceId: z.string().min(1),
            text: z.string().trim().min(2).max(600),
          })
          .strict(),
      )
      .max(6)
      .optional(),
  })
  .strict();

/** The model selects evidence and presentation; customer-facing facts still come from the server. */
export type ReplyKind = "clarify" | "grounded" | "handoff";
export const clarificationReply =
  "请补充具体商品、规格、数量，或本人订单及售后原因和商品明细。信息完整后才能核对事实或生成待确认卡片；也可以转人工。";
export const handoffReply =
  "目前无法从已发布资料或本人业务记录确认答案，请补充具体商品、规格或订单，或转人工核实。支付、物流和退款均为模拟。";
const yuan = (cents: number) =>
  `${BigInt(cents) / 100n}.${String(BigInt(cents) % 100n).padStart(2, "0")}元`;
const orderStatuses: Record<string, string> = {
  pending: "待付款",
  paid: "已付款，待发货",
  shipped: "已发货，待收货",
  completed: "已确认收货",
  cancelled: "已取消",
  refunded: "商品已全部退款",
};
const saleStatuses: Record<string, string> = {
  requested: "申请待审核",
  approved: "审核通过",
  rejected: "审核拒绝",
  returning: "退货途中",
  received: "退货已接收",
  refunded: "已模拟退款",
  cancelled: "已撤销",
};
export function renderGroundedAnswer(input: {
  kind: ReplyKind;
  presentation?: z.infer<typeof answerPresentationSchema>;
  sources: { id: string; title: string; text: string }[];
  products: {
    name: string;
    material: string;
    description: string;
    skus: { name: string; price: number; availableStock: number }[];
  }[];
  order?: {
    id: string;
    status: string;
    total: number;
    createdAtDisplay?: string;
    carrier?: string;
    tracking?: string;
    expiresAtDisplay?: string;
    items: {
      name: string;
      skuName: string;
      quantity: number;
      refundedQuantity: number;
      total: number;
    }[];
  };
  afterSales: { id: string; status: string; refundAmount: number }[];
  proposals: string[];
}) {
  // A valid pending proposal is always described as pending, regardless of model wording.
  const proposalText = input.proposals.map(
    (summary) =>
      `待确认操作：${summary}。请核对卡片后点击确认，确认前不会执行。`,
  );
  if (input.kind === "clarify") {
    const labels = {
      product: "具体商品",
      sku: "商品规格",
      quantity: "购买数量",
      order: "本人订单号",
      reason: "售后原因",
      items: "申请售后的商品明细和数量",
    };
    const missing = input.presentation?.missingFields;
    return [
      ...proposalText,
      missing?.length
        ? `请补充${[...new Set(missing)].map((field) => labels[field]).join("、")}，核对后再为你生成待确认卡片。`
        : clarificationReply,
    ].join("\n");
  }
  if (input.kind === "handoff")
    return [...proposalText, handoffReply].join("\n");
  const facts: string[] = [...proposalText];
  const quotes = input.presentation?.sourceQuotes ?? [];
  for (const quote of quotes) {
    const source = input.sources.find((source) => source.id === quote.sourceId);
    const start = source?.text.indexOf(quote.text) ?? -1;
    const before = source?.text.slice(0, start).replace(/[ \t\r]+$/, "") ?? "";
    const after =
      source?.text.slice(start + quote.text.length).replace(/^[ \t\r]+/, "") ??
      "";
    // A substring alone could turn “不支持…” into “支持…”. Select complete sentences only.
    if (
      start < 0 ||
      (before && !/[。！？；\n]$/.test(before)) ||
      (after && !/[。！？；]$/.test(quote.text) && !after.startsWith("\n"))
    )
      throw new Error("AI_INVALID_SOURCE_QUOTE");
  }
  for (const source of input.sources) {
    const selected = quotes.filter((quote) => quote.sourceId === source.id);
    facts.push(
      `已发布资料摘录（${source.title}）：\n${selected.length ? selected.map((quote) => quote.text).join("\n") : source.text}`,
    );
  }
  const view = input.presentation?.productView ?? "details";
  const fields = input.presentation?.focus ?? [
    "description",
    "material",
    "price",
    "stock",
  ];
  if (input.products.length && view === "compare")
    facts.push("商品对比（按当前查询到的规格）：");
  if (input.products.length && view === "recommend")
    facts.push("可选商品（仅展示当前有货且符合本轮检索价格条件的规格）：");
  for (const product of input.products) {
    const parts: string[] = [];
    if (fields.includes("description")) parts.push(product.description);
    if (fields.includes("material")) parts.push(`材质${product.material}`);
    if (fields.includes("price") || fields.includes("stock"))
      parts.push(
        product.skus
          .map((sku) =>
            [
              sku.name,
              ...(fields.includes("price") ? [`价格${yuan(sku.price)}`] : []),
              ...(fields.includes("stock")
                ? [`可售库存${sku.availableStock}件`]
                : []),
            ].join("，"),
          )
          .join("；"),
      );
    facts.push(`${product.name}：${parts.join("。")}。`);
  }
  if (view === "compare" || view === "recommend") {
    const candidates = input.products
      .flatMap((product) =>
        product.skus
          .filter((sku) => sku.availableStock > 0)
          .map((sku) => ({ product, sku })),
      )
      .sort((a, b) => a.sku.price - b.sku.price);
    if (candidates.length > 1 && fields.includes("price")) {
      const first = candidates[0]!,
        last = candidates.at(-1)!;
      facts.push(
        `价格取舍：本次列出的有货规格中，${first.product.name}／${first.sku.name}价格最低，为${yuan(first.sku.price)}；与最高价规格相差${yuan(last.sku.price - first.sku.price)}。`,
      );
    }
    if (fields.includes("material") || fields.includes("description"))
      facts.push(
        "用途与材质取舍请参考上方商品资料；资料未提供的性能与效果需进一步核实。",
      );
  }
  if (input.order) {
    const order = input.order;
    facts.push(
      `订单${order.id}：${orderStatuses[order.status] ?? "状态请在订单详情核对"}；应付${yuan(order.total)}。${order.createdAtDisplay ? `创建时间${order.createdAtDisplay}。` : ""}`,
    );
    if (order.status === "pending" && order.expiresAtDisplay)
      facts.push(`付款期限${order.expiresAtDisplay}。`);
    for (const item of order.items)
      facts.push(
        `${item.name}／${item.skuName}，购买${item.quantity}件，已退${item.refundedQuantity}件，商品实付${yuan(item.total)}。`,
      );
    if (["pending", "paid"].includes(order.status))
      facts.push("模拟物流尚未发货，无签收记录。");
    else if (order.carrier || order.tracking)
      facts.push(
        `模拟物流：${order.carrier ?? ""} ${order.tracking ?? ""}，实际进度请核对订单详情。`,
      );
    for (const sale of input.afterSales)
      facts.push(
        `售后${sale.id}：${saleStatuses[sale.status] ?? "进度请核对售后详情"}，申请退款金额${yuan(sale.refundAmount)}。`,
      );
  }
  return facts.length ? facts.join("\n") : handoffReply;
}
