<script setup lang="ts">
import { computed } from "vue";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import { dateTime } from "../../domain/types";
import type { Review } from "../../domain/types";
import { useAdminAction } from "./useAdmin";
import { useAdminQuery, useAdminPagination } from "./useAdminList";
import { reviewState, reviewLabels } from "../../../../shared/domain/reviews";
import "../../styles/account-commerce.css";

const shop = useShop(),
  { busy, pending, run } = useAdminAction();
const filters = useAdminQuery(),
  query = filters.field("q", { replace: true }),
  status = filters.field("status", { values: Object.keys(reviewLabels) }),
  orderId = filters.field("orderId"),
  detailId = filters.field("detail", { resetPage: false });
const selected = computed(() =>
  shop.db.reviews.find((r) => r.id === detailId.value),
);
const dialog = computed({
  get: () => !!detailId.value,
  set: (open) => {
    if (!open) detailId.value = "";
  },
});
const state = (review: Review) => reviewState(shop.db.orders, review);
const canModerate = (review: Review) =>
  ["visible", "hidden"].includes(state(review));
const hasOrder = (review: Review) =>
  shop.db.orders.some(
    (o) => o.id === review.orderId && o.userId === review.userId,
  );
async function moderate(review: Review) {
  if (!canModerate(review)) return;
  await run(
    () => api.moderateReview(review.id, !review.hidden),
    review.hidden ? "评价已恢复" : "评价已隐藏",
  );
}
const filtered = computed(() =>
  shop.db.reviews
    .filter(
      (review) =>
        (!query.value.trim() ||
          [
            review.id,
            review.orderId,
            review.content,
            shop.db.products.find((p) => p.id === review.productId)?.name ?? "",
          ].some((value) =>
            value.toLowerCase().includes(query.value.trim().toLowerCase()),
          )) &&
        (!orderId.value || review.orderId === orderId.value) &&
        (!status.value || state(review) === status.value),
    )
    .slice()
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    ),
);
const { page, rows, total } = useAdminPagination(filtered, filters);
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
        maxlength="100"
        placeholder="商品 / 内容 / 订单号 / 评价编号"
        clearable
      /><el-select v-model="status" placeholder="全部状态" clearable
        ><el-option
          v-for="(label, value) in reviewLabels"
          :key="value"
          :label="label"
          :value="value" /></el-select
      ><el-button
        @click="
          filters.update(
            { q: '', status: '', orderId: '' },
            { resetPage: true },
          )
        "
        >重置筛选</el-button
      ><span class="admin-note"
        >{{ total }} 条评价<span v-if="orderId">
          · 订单 {{ orderId }}</span
        ></span
      >
    </div>
    <el-table :data="rows" empty-text="暂无符合条件的评价">
      <el-table-column label="商品 / 订单" min-width="180"
        ><template #default="{ row }"
          >{{
            shop.db.products.find((p) => p.id === row.productId)?.name ??
            "历史商品"
          }}<small style="display: block; color: #7a828f"
            ><RouterLink
              v-if="hasOrder(row)"
              :to="{ path: '/admin/orders', query: { detail: row.orderId } }"
              >{{ row.orderId }}</RouterLink
            ><span v-else>{{ row.orderId }} · 关联订单不可用</span></small
          ></template
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
            reviewLabels[state(row)]
          }}</el-tag></template
        ></el-table-column
      >
      <el-table-column label="发布时间" min-width="170"
        ><template #default="{ row }">{{
          dateTime(row.createdAt)
        }}</template></el-table-column
      >
      <el-table-column label="操作" width="160" fixed="right"
        ><template #default="{ row }"
          ><el-button link @click="detailId = row.id">查看详情</el-button
          ><el-button
            v-if="canModerate(row)"
            link
            type="primary"
            :loading="pending"
            :disabled="busy"
            @click="moderate(row)"
            >{{ row.hidden ? "恢复展示" : "隐藏评价" }}</el-button
          ><span v-else class="admin-note">不可恢复</span></template
        ></el-table-column
      >
    </el-table>
    <div class="admin-pagination">
      <el-pagination
        v-model:current-page="page"
        :page-size="10"
        :total="total"
        layout="prev,pager,next,total"
      />
    </div>
  </section>
  <el-dialog v-model="dialog" title="评价详情" width="640px">
    <template v-if="selected"
      ><p>{{ selected.id }} · {{ reviewLabels[state(selected)] }}</p>
      <p>{{ selected.rating }} 星 · {{ dateTime(selected.createdAt) }}</p>
      <p class="review-content">{{ selected.content }}</p>
      <RouterLink
        v-if="hasOrder(selected)"
        :to="{ path: '/admin/orders', query: { detail: selected.orderId } }"
        >查看订单 {{ selected.orderId }}</RouterLink
      >
      <p v-if="!canModerate(selected)" class="admin-note">
        该评价仅保留历史，不参与公开展示和评分，不能恢复展示。
      </p></template
    >
    <el-alert v-else title="没有找到该评价" type="warning" :closable="false" />
    <template #footer
      ><el-button @click="dialog = false">关闭</el-button></template
    >
  </el-dialog>
</template>
