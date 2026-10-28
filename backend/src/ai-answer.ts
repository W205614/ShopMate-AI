/** The model selects evidence; only server-owned templates become customer-facing facts. */
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
  sources: { title: string; text: string }[];
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
  if (input.kind === "clarify")
    return [...proposalText, clarificationReply].join("\n");
  if (input.kind === "handoff")
    return [...proposalText, handoffReply].join("\n");
  const facts: string[] = [...proposalText];
  for (const source of input.sources)
    facts.push(`已发布资料摘录（${source.title}）：\n${source.text}`);
  for (const product of input.products)
    facts.push(
      `${product.name}：${product.description} 材质${product.material}。${product.skus.map((sku) => `${sku.name}，价格${yuan(sku.price)}，可售库存${sku.availableStock}件`).join("；")}。`,
    );
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
