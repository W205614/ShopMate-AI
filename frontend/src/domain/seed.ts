import type { Database, Product, Order, OrderStatus } from "./types";

const catalog = [
  [
    "静听 无线头戴耳机",
    "把通勤调成自己的频道",
    39900,
    "数码电器",
    "40 小时续航，柔软耳罩与双设备连接。",
    "磨砂铝合金 · 蛋白皮耳罩",
    "雾白 / 标准版",
    "深灰 / 标准版",
  ],
  [
    "轻敲 机械键盘",
    "每一次输入，都清晰有声",
    28900,
    "数码电器",
    "紧凑 84 键布局，可拆卸连接线，适合日常办公。",
    "PBT 键帽 · 铝合金底板",
    "浅灰 / 茶轴",
    "墨黑 / 红轴",
  ],
  [
    "明度 桌面阅读灯",
    "给深夜留一束好光",
    16900,
    "数码电器",
    "三档色温，触控调光；适合书桌和床头阅读。",
    "金属灯臂 · ABS 底座",
    "暖白",
    "石墨",
  ],
  [
    "随行 蓝牙音箱",
    "把喜欢的歌带出门",
    22900,
    "数码电器",
    "掌心大小，支持蓝牙连接与 USB-C 充电。",
    "织物包覆 · 硅胶底座",
    "海盐蓝",
    "炭黑",
  ],
  [
    "日常 陶瓷马克杯",
    "慢一点，再喝一口",
    5900,
    "家居生活",
    "350ml 陶瓷杯，杯口圆润。适用于日常热饮。",
    "高温烧制陶瓷",
    "白釉",
    "灰釉",
  ],
  [
    "留白 陶瓷花器",
    "一枝花，也能改变房间",
    8900,
    "家居生活",
    "哑光表面与自然轮廓，适合插花或独立陈列。",
    "手工质感陶瓷",
    "砂白",
    "浅灰",
  ],
  [
    "云间 棉麻靠垫",
    "回家，靠一会儿",
    7900,
    "家居生活",
    "45 × 45cm，可拆洗外套，柔软填充。",
    "棉麻混纺 · 聚酯纤维填充",
    "自然米",
    "烟灰",
  ],
  [
    "有序 编织收纳篮",
    "让琐碎各就各位",
    6900,
    "家居生活",
    "桌面与床边均可使用，轻便提手方便移动。",
    "天然编织纤维",
    "原色 / 小号",
    "原色 / 大号",
  ],
  [
    "漫步 帆布托特包",
    "装下今天的小计划",
    9900,
    "服饰箱包",
    "可放入 A4 文件，内设小口袋，适合日常通勤。",
    "加厚棉帆布",
    "原白",
    "墨黑",
  ],
  [
    "周末 棒球帽",
    "走进阳光里",
    6900,
    "服饰箱包",
    "后围可调节，轻量透气，适合日常出行。",
    "棉质斜纹面料",
    "米色",
    "黑色",
  ],
  [
    "本色 棉质衬衫",
    "简单，自有分寸",
    15900,
    "服饰箱包",
    "宽松直筒版型，尺码请参考详情说明。",
    "100% 棉",
    "白色 / M",
    "白色 / L",
  ],
  [
    "轻旅 双肩背包",
    "背上就走",
    19900,
    "服饰箱包",
    "独立电脑夹层与多个收纳分区，容量约 18L。",
    "耐磨涤纶",
    "黑色",
    "灰绿色",
  ],
  [
    "晨起 中烘咖啡豆",
    "从一杯开始今天",
    7900,
    "食品饮品",
    "250g 演示包装；风味描述为坚果、可可。食品信息以实物标签为准。",
    "咖啡豆 · 演示商品",
    "250g / 咖啡豆",
    "250g / 研磨粉",
  ],
  [
    "山间 绿茶",
    "给忙碌按下暂停",
    8900,
    "食品饮品",
    "100g 演示包装，建议密封避光保存。",
    "茶叶 · 演示商品",
    "100g / 罐装",
    "100g / 袋装",
  ],
  [
    "谷物 原味燕麦",
    "早餐可以很简单",
    3900,
    "食品饮品",
    "500g 演示包装，建议搭配牛奶或酸奶。含麸质谷物，请留意过敏原。",
    "燕麦 · 含麸质",
    "500g / 原味",
    "500g / 混合谷物",
  ],
  [
    "片刻 黑巧克力",
    "一点甜，刚刚好",
    4900,
    "食品饮品",
    "100g 演示包装，含乳及大豆成分。食品过敏请核对标签。",
    "可可制品 · 含乳与大豆",
    "70% / 100g",
    "85% / 100g",
  ],
  [
    "净手 植物皂",
    "让清洁回归简单",
    2900,
    "美妆个护",
    "100g，温和清洁。敏感肤质建议先局部测试。",
    "植物油基皂",
    "无香",
    "草本",
  ],
  [
    "柔润 护手霜",
    "照顾每天忙碌的双手",
    4900,
    "美妆个护",
    "50ml 便携包装。日常滋润，实际体验因人而异。",
    "护肤乳霜 · 非医疗用品",
    "无香 / 50ml",
    "木质 / 50ml",
  ],
  [
    "暮色 香氛蜡烛",
    "属于自己的安静片刻",
    11900,
    "美妆个护",
    "180g 演示规格。使用时请远离可燃物与儿童，勿无人看管燃烧。",
    "植物蜡 · 玻璃杯",
    "雪松",
    "白茶",
  ],
  [
    "清晨 温和洁面",
    "洗去疲惫，轻装开始",
    6900,
    "美妆个护",
    "120ml 日常洁面产品，避免接触眼睛。",
    "洁面乳 · 非医疗用品",
    "120ml / 清爽",
    "120ml / 柔润",
  ],
  [
    "远行 随行水杯",
    "每次出发，记得喝水",
    8900,
    "运动户外",
    "600ml 演示规格，密封杯盖，适合日常出行。",
    "透明塑料 / 食品接触材料（演示规格）",
    "透明 / 600ml",
    "烟灰 / 600ml",
  ],
  [
    "舒展 训练瑜伽垫",
    "留一点时间给身体",
    12900,
    "运动户外",
    "约 183 × 61cm，厚 6mm，配收纳绑带。",
    "TPE 材质",
    "鼠尾草绿",
    "深灰",
  ],
  [
    "轻跑 日常运动鞋",
    "下一步，自在一点",
    25900,
    "运动户外",
    "轻量网面与缓震鞋底，适合日常轻运动。",
    "透气织物 · EVA 鞋底",
    "米白 / 38",
    "米白 / 40",
  ],
  [
    "星野 露营提灯",
    "在夜色里，留一盏灯",
    15900,
    "运动户外",
    "可调亮度，便携提手。演示商品当前下架。",
    "金属 · ABS",
    "森林绿",
    "砂岩白",
  ],
] as const;

export function createSeed(): Database {
  const now = Date.now();
  const at = (days: number) => new Date(now - days * 86400000).toISOString();
  const names = [
    "数码电器",
    "家居生活",
    "服饰箱包",
    "食品饮品",
    "美妆个护",
    "运动户外",
  ];
  const descriptions = [
    "工作与娱乐，找到合拍的装备。",
    "让日常多一点舒服。",
    "轻松穿着，装下每一天。",
    "认真吃饭，好好喝一杯。",
    "留一点时间照顾自己。",
    "走出去，感受生活的另一面。",
  ];
  const products: Product[] = catalog.map((row, index) => {
    const id = `p${String(index + 1).padStart(2, "0")}`;
    return {
      id,
      name: row[0],
      subtitle: row[1],
      categoryId: `c${Math.floor(index / 4) + 1}`,
      description: row[4],
      images: [`/images/${id}.jpg`],
      material: row[5],
      active: index !== 23,
      featured: index % 4 === 0,
      skus: [0, 1].map((n) => ({
        id: `${id}-s${n + 1}`,
        name: String(row[6 + n]),
        price: row[2] + n * 1000,
        stock: index === 21 ? 0 : index === 2 ? 3 + n : 20 + index + n,
      })),
    };
  });
  const users = [
    { id: "u1", username: "lin", name: "林小满" },
    { id: "u2", username: "chen", name: "陈一禾" },
  ];
  const openingInventory = products.flatMap((p) =>
    p.skus
      .filter((s) => s.stock > 0)
      .map((s) => ({
        id: `opening-${s.id}`,
        productId: p.id,
        skuId: s.id,
        delta: s.stock,
        reason: "演示期初库存",
        createdAt: at(8),
      })),
  );
  const addresses = users.map((u, i) => ({
    id: `a${i + 1}`,
    userId: u.id,
    name: `${u.name}（演示）`,
    phone: `1380000000${i + 1}`,
    region: "上海市 浦东新区",
    detail: `演示路 ${i + 1} 号（虚构地址，请勿发货）`,
    isDefault: true,
  }));
  const statuses: OrderStatus[] = [
    "completed",
    "completed",
    "completed",
    "shipped",
    "paid",
    "pending",
    "cancelled",
  ];
  const orders: Order[] = statuses.map((status, index) => {
    const p = products[index]!,
      sku = p.skus[0]!,
      address = addresses[index % 2]!;
    if (["paid", "shipped", "completed"].includes(status)) sku.stock--;
    return {
      id: `SM${String(index + 1).padStart(6, "0")}`,
      userId: address.userId,
      items: [
        {
          productId: p.id,
          skuId: sku.id,
          name: p.name,
          skuName: sku.name,
          image: p.images[0]!,
          price: sku.price,
          quantity: 1,
        },
      ],
      total: sku.price,
      status,
      address: { ...address },
      createdAt: at(7 - index),
      ...(["paid", "shipped", "completed"].includes(status)
        ? { paidAt: at(7 - index) }
        : {}),
      ...(["shipped", "completed"].includes(status)
        ? {
            carrier: "演示物流",
            tracking: `DEMO${1000 + index}`,
            shippedAt: at(6 - index),
          }
        : {}),
    };
  });
  return {
    version: 1,
    revision: 0,
    users,
    categories: names.map((name, index) => ({
      id: `c${index + 1}`,
      name,
      description: descriptions[index]!,
      image: `/images/p${String(index * 4 + 1).padStart(2, "0")}.jpg`,
      sort: index + 1,
    })),
    products,
    carts: [],
    addresses,
    favorites: { u1: ["p01", "p05"], u2: ["p13"] },
    orders,
    afterSales: [],
    inventory: [
      ...orders
        .filter((o) => o.paidAt)
        .flatMap((o) =>
          o.items.map((i, n) => ({
            id: `seed-stock-${o.id}-${n}`,
            productId: i.productId,
            skuId: i.skuId,
            delta: -i.quantity,
            reason: `订单付款 ${o.id}`,
            createdAt: o.paidAt!,
          })),
        ),
      ...openingInventory,
    ],
    ledger: orders
      .filter((o) => o.paidAt)
      .map((o) => ({
        id: `seed-payment-${o.id}`,
        type: "payment",
        amount: o.total,
        reference: o.id,
        note: "初始演示订单收款",
        createdAt: o.paidAt!,
      })),
    conversations: [],
    faqs: [
      {
        id: "f1",
        question: "什么时候发货？",
        keywords: ["发货", "配送", "快递", "几天"],
        answer:
          "这是本地前端演示。管理员可在订单管理中模拟发货，填写的物流信息会同步到订单详情；不会产生真实快递。",
        active: true,
      },
      {
        id: "f2",
        question: "如何申请售后？",
        keywords: ["退货", "退款", "售后"],
        answer:
          "请在“我的订单”中打开已付款订单，点击申请售后。未发货订单审核后可模拟退款；已发货订单需要管理员确认退货收货后再退款。",
        active: true,
      },
      {
        id: "f3",
        question: "支付安全吗？",
        keywords: ["支付", "付款", "安全"],
        answer:
          "本站仅提供模拟支付，不会收取任何款项，也不需要输入银行卡或支付密码。请在订单支付页主动确认。",
        active: true,
      },
      {
        id: "f4",
        question: "食品过敏怎么办？",
        keywords: ["过敏", "食品", "成分"],
        answer:
          "演示商品说明不能作为过敏安全保证。请核对商品成分及过敏原标签；信息不足时不要购买，可转人工咨询。",
        active: true,
      },
    ],
    settings: {
      name: "ShopMate",
      slogan: "好物与答案，一起找到。",
      notice: "前端演示 · 商品、交易与客服回复均为模拟",
    },
  };
}
