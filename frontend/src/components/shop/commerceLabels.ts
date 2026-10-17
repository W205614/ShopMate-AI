export const eventLabel = (action: string) =>
  ({
    created: "订单已创建",
    paid: "模拟付款成功",
    shipped: "已模拟发货",
    completed: "已确认收货",
    cancelled: "已取消",
    afterSaleRequested: "已提交售后",
    requested: "售后已申请",
    approve: "审核通过",
    reject: "申请已拒绝",
    returning: "已提交退货单号",
    receive: "管理员已确认退货收货",
    refund: "模拟退款完成",
  })[action] ?? action;
