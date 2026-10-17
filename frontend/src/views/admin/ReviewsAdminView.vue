<script setup lang="ts">
import { computed, ref } from "vue";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import { dateTime } from "../../domain/types";
import type { Review } from "../../domain/types";
import { useAdminAction } from "./useAdmin";
import "../../styles/account-commerce.css";

const shop = useShop(),
  { busy, run } = useAdminAction();
const query = ref(""),
  status = ref("");
async function moderate(review: Review) {
  await run(
    () => api.moderateReview(review.id, !review.hidden),
    review.hidden ? "评价已恢复" : "评价已隐藏",
  );
}
function fullyRefunded(orderId: string, orderItemId: string) {
  const item = shop.db.orders
    .find((o) => o.id === orderId)
    ?.items.find((i) => i.id === orderItemId);
  return item && item.refundedQuantity === item.quantity;
}
const rows = computed(() =>
  shop.db.reviews
    .filter(
      (review) =>
        (!query.value ||
          review.content.includes(query.value) ||
          shop.db.products
            .find((p) => p.id === review.productId)
            ?.name.includes(query.value)) &&
        (!status.value ||
          (status.value === "deleted"
            ? review.deleted
            : status.value === "hidden"
              ? review.hidden && !review.deleted
              : !review.hidden && !review.deleted)),
    )
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
);
</script>
<template>
  <div class="admin-page-head">
    <div>
      <h1>评价管理</h1>
      <p>保留真实购买记录，隐藏的评价不参与公开展示与评分。</p>
    </div>
  </div>
  <section class="admin-panel">
    <div class="admin-toolbar">
      <el-input
        v-model="query"
        placeholder="商品名 / 评价内容"
        clearable
      /><el-select v-model="status" placeholder="全部状态" clearable
        ><el-option label="已发布" value="visible" /><el-option
          label="已隐藏"
          value="hidden" /><el-option
          label="用户已删除"
          value="deleted" /></el-select
      ><span class="admin-note">{{ rows.length }} 条评价</span>
    </div>
    <el-table :data="rows" empty-text="暂无符合条件的评价">
      <el-table-column label="商品 / 订单" min-width="180"
        ><template #default="{ row }"
          >{{
            shop.db.products.find((p) => p.id === row.productId)?.name ??
            "历史商品"
          }}<small style="display: block; color: #7a828f">{{
            row.orderId
          }}</small></template
        ></el-table-column
      >
      <el-table-column label="用户" min-width="100"
        ><template #default="{ row }">{{
          shop.db.users.find((u) => u.id === row.userId)?.name ?? "历史用户"
        }}</template></el-table-column
      >
      <el-table-column label="评分" width="75"
        ><template #default="{ row }"
          >{{ row.rating }} 星</template
        ></el-table-column
      >
      <el-table-column label="评价内容" min-width="230"
        ><template #default="{ row }"
          ><p class="review-content">{{ row.content }}</p></template
        ></el-table-column
      >
      <el-table-column label="状态" min-width="140"
        ><template #default="{ row }"
          ><el-tag effect="plain">{{
            row.deleted ? "用户已删除" : row.hidden ? "已隐藏" : "已发布"
          }}</el-tag
          ><small
            v-if="fullyRefunded(row.orderId, row.orderItemId)"
            style="display: block; color: #7a828f"
            >已全退，仅保留历史</small
          ></template
        ></el-table-column
      >
      <el-table-column label="发布时间" min-width="170"
        ><template #default="{ row }">{{
          dateTime(row.createdAt)
        }}</template></el-table-column
      >
      <el-table-column label="操作" width="100" fixed="right"
        ><template #default="{ row }"
          ><el-button
            v-if="!row.deleted"
            link
            type="primary"
            :loading="busy"
            @click="moderate(row)"
            >{{ row.hidden ? "恢复展示" : "隐藏评价" }}</el-button
          ><span v-else class="admin-note">不可恢复</span></template
        ></el-table-column
      >
    </el-table>
  </section>
</template>
