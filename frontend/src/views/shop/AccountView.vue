<script setup lang="ts">
import CollectionPager from "../../components/shop/CollectionPager.vue";
import { computed, reactive, ref, watch } from "vue";
import { useRoute, useRouter, type LocationQuery } from "vue-router";
import { useShop } from "../../stores/shop";
import { api } from "../../services/api";
import type {
  Address,
  AddressInput,
  Coupon,
  CouponClaim,
} from "../../domain/types";
import { dateTime, money } from "../../domain/types";
import { UserRound, ArrowUpRight } from "lucide-vue-next";
import ProductCard from "../../components/shop/ProductCard.vue";
import ActionNotice from "../../components/shop/ActionNotice.vue";
import { useAction } from "../../components/shop/useAction";
import { reviewWriteReason } from "../../domain/reviewWriteState";
import { reviewState, reviewLabels } from "../../../../shared/domain/reviews";
import "../../styles/account-commerce.css";

const shop = useShop(),
  route = useRoute(),
  router = useRouter();
const sections = [
  ["overview", "我的收藏"],
  ["addresses", "收货地址"],
  ["profile", "个人资料"],
  ["security", "账号安全"],
  ["coupons", "我的优惠券"],
  ["pending-reviews", "待评价"],
  ["reviews", "我的评价"],
];
const section = computed(() =>
  sections.some(([key]) => key === route.query.section)
    ? String(route.query.section)
    : "overview",
);
const editing = ref(false);
const form = reactive<AddressInput>({
  name: "",
  phone: "",
  region: "",
  province: "",
  detail: "",
  isDefault: false,
});
const profileName = ref(shop.user?.name ?? "");
watch(
  () => shop.user?.name,
  (name) => {
    profileName.value = name ?? "";
  },
);
const password = reactive({ current: "", next: "", confirm: "" });
const { busy, pending, error, notice, run } = useAction();
const favorites = computed(() =>
  shop.db.products.filter((p) =>
    shop.db.favorites[shop.userId]?.includes(p.id),
  ),
);
const coupons = computed(() =>
  shop.db.couponClaims
    .filter((c) => c.userId === shop.userId)
    .map((claim) => ({
      claim,
      coupon: shop.db.coupons.find((c) => c.id === claim.couponId),
    })),
);
const myReviews = computed(() =>
  shop.db.reviews
    .filter((r) => r.userId === shop.userId)
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
);
const hasOrderFilter = computed(() => route.query.orderId !== undefined);
const reviewOrder = computed(() =>
  typeof route.query.orderId === "string"
    ? shop.myOrders.find((o) => o.id === route.query.orderId)
    : undefined,
);
const reviewEntries = computed(() =>
  shop.myOrders
    .filter(
      (order) => !hasOrderFilter.value || order.id === reviewOrder.value?.id,
    )
    .flatMap((order) =>
      order.items.map((item) => ({
        order,
        item,
        reason: reviewWriteReason(
          order,
          item,
          shop.db.reviews,
          shop.db.afterSales,
        ),
      })),
    ),
);
const pendingReviews = computed(() =>
  reviewEntries.value.filter((entry) => !entry.reason),
);
const blockedReviews = computed(() =>
  reviewEntries.value.filter(
    (entry) =>
      entry.reason &&
      (hasOrderFilter.value ||
        (entry.order.id === reviewForm.orderId &&
          entry.item.id === reviewForm.orderItemId)),
  ),
);
const reviewForm = reactive({
  orderId: "",
  orderItemId: "",
  rating: 5,
  content: "",
});

function selectSection(value: string) {
  const query: LocationQuery = { ...route.query, section: value };
  if (value !== "pending-reviews") delete query.orderId;
  void router.replace({ query });
}
function couponStatus(claim: CouponClaim, coupon?: Coupon) {
  if (claim.status === "locked") return "订单占用中";
  if (claim.status === "used") return "已使用";
  if (!coupon || Date.now() > Date.parse(coupon.validUntil)) return "已过期";
  if (!coupon.active) return "已停用";
  if (Date.now() < Date.parse(coupon.validFrom)) return "未到使用时间";
  return "可使用";
}
function edit(a?: Address) {
  Object.assign(form, {
    id: a?.id,
    name: a?.name ?? "",
    phone: a?.phone ?? "",
    region: a?.region ?? "",
    province: a?.province ?? "",
    detail: a?.detail ?? "",
    isDefault: a?.isDefault ?? shop.myAddresses.length === 0,
  });
  editing.value = true;
}
async function save() {
  if (await run(() => api.saveAddress({ ...form }), "收货地址已保存"))
    editing.value = false;
}
async function remove(id: string) {
  if (window.confirm("确认删除这个收货地址？"))
    await run(() => api.deleteAddress(id), "地址已删除");
}
async function logout() {
  if (await run(() => shop.logout("user"))) await router.push("/");
}
async function removeFavorite(id: string) {
  await run(() => api.favorite(id, false), "已取消收藏");
}
async function saveProfile() {
  await run(() => api.updateProfile(profileName.value), "昵称已更新");
}
async function changePassword() {
  if (password.next !== password.confirm)
    return void (await run(async () => {
      throw Error("两次输入的新密码不一致");
    }));
  if (await run(() => api.changePassword(password.current, password.next))) {
    Object.assign(password, { current: "", next: "", confirm: "" });
  }
}
async function submitReview() {
  const order = shop.myOrders.find((o) => o.id === reviewForm.orderId);
  const reason = reviewWriteReason(
    order,
    order?.items.find((i) => i.id === reviewForm.orderItemId),
    shop.db.reviews,
    shop.db.afterSales,
  );
  if (reason)
    return void (await run(async () => {
      throw new Error(reason);
    }));
  if (
    await run(
      () =>
        api.submitReview({
          orderId: reviewForm.orderId,
          orderItemId: reviewForm.orderItemId,
          rating: reviewForm.rating,
          content: reviewForm.content,
        }),
      "评价已发布",
    )
  ) {
    Object.assign(reviewForm, {
      orderId: "",
      orderItemId: "",
      rating: 5,
      content: "",
    });
  }
}
async function deleteReview(id: string) {
  if (window.confirm("删除评价后将不再公开展示，且不能重新评价。确认删除？"))
    await run(() => api.deleteReview(id), "评价已删除");
}
</script>
<template>
  <div class="page-wrap account-page">
    <div class="account-welcome">
      <div class="account-avatar"><UserRound :size="32" /></div>
      <div>
        <h1>{{ shop.user?.name }}，你好。</h1>
        <p>选购、收藏与收货，都在你的日常里。</p>
      </div>
      <button class="text-link" :disabled="busy" @click="logout">
        退出登录
      </button>
    </div>
    <div class="account-shortcuts">
      <RouterLink to="/points"
        ><span>会员积分</span><strong>余额与明细</strong><ArrowUpRight
      /></RouterLink>
      <RouterLink to="/notifications"
        ><span>站内通知</span><strong>交易动态</strong><ArrowUpRight
      /></RouterLink>
      <RouterLink to="/orders"
        ><span>我的订单</span><strong>{{ shop.summary.orderCount }}</strong
        ><ArrowUpRight
      /></RouterLink>
      <RouterLink to="/after-sales"
        ><span>售后服务</span><strong>{{ shop.summary.afterSaleCount }}</strong
        ><ArrowUpRight
      /></RouterLink>
      <RouterLink to="/coupons"
        ><span>领券中心</span
        ><strong>{{ shop.summary.couponClaimCount }}</strong
        ><ArrowUpRight
      /></RouterLink>
    </div>
    <div class="tabs commerce-tabs" aria-label="个人中心功能">
      <button
        v-for="[key, label] in sections"
        :key="key"
        :class="{ selected: section === key }"
        @click="selectSection(key!)"
      >
        {{ label }}
      </button>
    </div>
    <ActionNotice :error="error" :notice="notice" />
    <section v-if="section === 'overview'">
      <div class="section-heading">
        <h2>留给下次的喜欢</h2>
        <span>{{ shop.summary.favoriteCount }} 件收藏</span>
      </div>
      <div v-if="favorites.length" class="product-grid">
        <article v-for="p in favorites" :key="p.id" class="favorite-entry">
          <ProductCard v-if="p.active" :product="p" />
          <div v-else class="inactive-favorite">
            <img :src="p.images[0]" :alt="p.name" />
            <h3>{{ p.name }}</h3>
            <p>商品已下架，暂不可购买</p>
          </div>
          <button
            class="text-link"
            :disabled="busy"
            :aria-label="`取消收藏 ${p.name}`"
            @click="removeFavorite(p.id)"
          >
            取消收藏
          </button>
        </article>
      </div>
      <div v-else class="empty-state">
        <h2>收藏夹等你来填满</h2>
        <p>在商品详情点击收藏，下次来就能快速找到。</p>
        <RouterLink to="/products" class="button">浏览商品</RouterLink>
      </div>
    </section>
    <section v-else-if="section === 'addresses'" data-ui>
      <div class="section-heading">
        <h2>收货地址</h2>
        <button class="button" @click="edit()">添加地址</button>
      </div>
      <form
        v-if="editing"
        class="address-form form-stack"
        @submit.prevent="save"
      >
        <h3>{{ form.id ? "编辑地址" : "添加收货地址" }}</h3>
        <div class="form-two">
          <label
            >收货人<input
              v-model.trim="form.name"
              required
              maxlength="30"
              autocomplete="name"
          /></label>
          <label
            >联系电话<input
              v-model.trim="form.phone"
              required
              pattern="1[0-9]{10}"
              placeholder="11 位手机号"
              inputmode="tel"
              autocomplete="tel"
          /></label>
        </div>
        <label
          >配送省份<input
            v-model.trim="form.province"
            required
            maxlength="30"
            placeholder="如：浙江省"
        /></label>
        <label
          >省 / 市 / 区<input
            v-model.trim="form.region"
            required
            maxlength="80"
            placeholder="例如：上海市 徐汇区"
            autocomplete="address-level2"
        /></label>
        <label
          >详细地址<input
            v-model.trim="form.detail"
            required
            maxlength="150"
            placeholder="街道、门牌号等"
            autocomplete="street-address"
        /></label>
        <label class="check-label"
          ><input
            v-model="form.isDefault"
            type="checkbox"
          />设为默认收货地址</label
        >
        <div class="button-row">
          <button class="button" :disabled="busy">
            {{ pending ? "保存中…" : "保存地址" }}</button
          ><button type="button" @click="editing = false">取消</button>
        </div>
        <p class="secondary">
          地址保存到服务端，仅当前账号与授权管理员可访问。
        </p>
      </form>
      <div v-if="shop.myAddresses.length" class="address-grid">
        <article v-for="a in shop.myAddresses" :key="a.id" class="address-card">
          <h3>
            {{ a.name }} <span>{{ a.phone }}</span>
          </h3>
          <p>{{ a.region }} {{ a.detail }}</p>
          <p v-if="a.isDefault" class="secondary">默认地址</p>
          <div class="button-row">
            <button @click="edit(a)">编辑</button
            ><button :disabled="busy" @click="remove(a.id)">删除</button>
          </div>
        </article>
      </div>
      <div v-else-if="!editing" class="empty-state">
        <h2>还没有收货地址</h2>
        <p>添加收货地址后，就可以完成下单。</p>
      </div>
    </section>
    <section v-else-if="section === 'profile'" data-ui>
      <div class="section-heading"><h2>个人资料</h2></div>
      <form class="form-stack commerce-form" @submit.prevent="saveProfile">
        <label
          >账号<input
            :value="shop.user?.username"
            disabled
            autocomplete="username"
        /></label>
        <label
          >昵称<input
            v-model.trim="profileName"
            required
            maxlength="30"
            autocomplete="nickname"
        /></label>
        <p class="secondary">昵称为 1–30 字；公开评价中会脱敏显示。</p>
        <button class="button" :disabled="busy">保存昵称</button>
      </form>
    </section>
    <section v-else-if="section === 'security'" data-ui>
      <div class="section-heading"><h2>修改登录密码</h2></div>
      <form class="form-stack commerce-form" @submit.prevent="changePassword">
        <input
          class="sr-only"
          :value="shop.user?.username"
          autocomplete="username"
          aria-label="当前账号"
          readonly
        />
        <label
          >原密码<input
            v-model="password.current"
            type="password"
            required
            maxlength="128"
            autocomplete="current-password"
        /></label>
        <label
          >新密码<input
            v-model="password.next"
            type="password"
            required
            minlength="10"
            maxlength="128"
            pattern="(?=.*[A-Za-z])(?=.*[0-9]).{10,128}"
            autocomplete="new-password"
        /></label>
        <label
          >确认新密码<input
            v-model="password.confirm"
            type="password"
            required
            minlength="10"
            maxlength="128"
            autocomplete="new-password"
        /></label>
        <p class="secondary">
          密码须为 10–128
          位并包含字母和数字。修改成功后，所有已登录设备需要重新登录。
        </p>
        <button class="button" :disabled="busy">修改密码并重新登录</button>
      </form>
    </section>
    <section v-else-if="section === 'coupons'">
      <div class="section-heading">
        <h2>我的优惠券</h2>
        <RouterLink to="/coupons" class="text-link">前往领券中心 ↗</RouterLink>
      </div>
      <div v-if="coupons.length" class="coupon-grid">
        <article
          v-for="{ claim, coupon } in coupons"
          :key="claim.id"
          class="commerce-coupon"
        >
          <span class="commerce-badge">{{ couponStatus(claim, coupon) }}</span>
          <h3>{{ coupon?.name ?? "优惠券" }}</h3>
          <strong>{{ money(coupon?.discount ?? 0) }}</strong>
          <p>满 {{ money(coupon?.threshold ?? 0) }} 可用 · 每单限用一张</p>
          <p v-if="coupon" class="secondary">
            使用时间：{{ dateTime(coupon.validFrom) }} 至
            {{ dateTime(coupon.validUntil) }}
          </p>
          <RouterLink
            v-if="claim.orderId"
            :to="`/orders/${claim.orderId}`"
            class="text-link"
            >查看关联订单</RouterLink
          >
          <RouterLink
            v-else-if="couponStatus(claim, coupon) === '可使用'"
            to="/products"
            class="text-link"
            >去选购</RouterLink
          >
        </article>
      </div>
      <div v-else class="empty-state">
        <h2>还没有优惠券</h2>
        <p>领取优惠券后，可在结算时选择使用。</p>
        <RouterLink to="/coupons" class="button">去领券</RouterLink>
      </div>
    </section>
    <section v-else-if="section === 'pending-reviews'" data-ui>
      <div class="section-heading">
        <h2>分享使用感受</h2>
        <span>{{ pendingReviews.length }} 件待评价</span>
      </div>
      <div v-if="hasOrderFilter" class="button-row">
        <RouterLink
          :to="{ path: '/account', query: { section: 'pending-reviews' } }"
          class="text-link"
          >查看全部待评价</RouterLink
        >
        <RouterLink
          v-if="reviewOrder"
          :to="`/orders/${reviewOrder.id}`"
          class="text-link"
          >返回订单 {{ reviewOrder.id }}</RouterLink
        >
      </div>
      <div
        v-for="entry in blockedReviews"
        :key="entry.item.id"
        class="action-notice"
        :role="
          entry.order.id === reviewForm.orderId &&
          entry.item.id === reviewForm.orderItemId
            ? 'alert'
            : undefined
        "
      >
        {{ entry.item.name }} · {{ entry.item.skuName }}：{{ entry.reason }}
        <span
          v-if="
            entry.order.id === reviewForm.orderId &&
            entry.item.id === reviewForm.orderItemId
          "
          >。编辑内容已保留<span
            v-if="entry.reason === '售后处理中，暂不可评价'"
            >，资格恢复后可继续</span
          >。</span
        >
      </div>
      <div v-if="hasOrderFilter && !reviewOrder" class="empty-state">
        <h2>未找到可访问的订单</h2>
        <p>请使用下单账号查看，或选择全部待评价商品。</p>
      </div>
      <div v-else-if="pendingReviews.length" class="commerce-list">
        <article
          v-for="{ order, item } in pendingReviews"
          :key="`${order.id}:${item.id}`"
          class="commerce-list-card"
        >
          <h3>{{ item.name }}</h3>
          <p>{{ item.skuName }} · 订单 {{ order.id }}</p>
          <button
            v-if="
              reviewForm.orderId !== order.id ||
              reviewForm.orderItemId !== item.id
            "
            class="button"
            :disabled="busy"
            @click="
              Object.assign(reviewForm, {
                orderId: order.id,
                orderItemId: item.id,
                rating: 5,
                content: '',
              })
            "
          >
            写评价
          </button>
          <form
            v-else
            class="form-stack commerce-form"
            @submit.prevent="submitReview"
          >
            <label
              >评分<select v-model.number="reviewForm.rating" aria-label="评分">
                <option
                  v-for="score in [5, 4, 3, 2, 1]"
                  :key="score"
                  :value="score"
                >
                  {{ score }} 星
                </option>
              </select></label
            >
            <label
              >评价内容<textarea
                v-model.trim="reviewForm.content"
                required
                minlength="5"
                maxlength="1000"
                rows="4"
                placeholder="分享真实的使用体验，5–1000 字"
              />
            </label>
            <div class="button-row">
              <button class="button" :disabled="busy">发布评价</button
              ><button type="button" @click="reviewForm.orderItemId = ''">
                取消
              </button>
            </div>
          </form>
        </article>
      </div>
      <div v-else class="empty-state">
        <h2>暂无待评价商品</h2>
        <p>
          确认收货后，尚有未退款数量的商品可在这里评价。有进行中售后时暂不可评价。
        </p>
        <RouterLink to="/orders" class="button">查看订单</RouterLink>
      </div>
    </section>
    <section v-else>
      <div class="section-heading">
        <h2>我的评价</h2>
        <span>{{ myReviews.length }} 条记录</span>
      </div>
      <div v-if="myReviews.length" class="commerce-list">
        <article
          v-for="review in myReviews"
          :key="review.id"
          class="commerce-list-card"
        >
          <div class="commerce-list-heading">
            <h3>
              {{
                shop.db.products.find((p) => p.id === review.productId)?.name ??
                "历史商品"
              }}
            </h3>
            <span class="commerce-badge">{{
              reviewLabels[reviewState(shop.db.orders, review)]
            }}</span>
          </div>
          <p>{{ review.rating }} 星 · {{ dateTime(review.createdAt) }}</p>
          <p class="review-content">{{ review.content }}</p>
          <p
            v-if="reviewState(shop.db.orders, review) === 'refunded'"
            class="secondary"
          >
            商品已全部退款，评价仅保留在你的历史记录中。
          </p>
          <div class="button-row">
            <RouterLink
              v-if="shop.myOrders.some((o) => o.id === review.orderId)"
              :to="`/orders/${review.orderId}`"
              class="text-link"
              >查看订单</RouterLink
            ><button
              v-if="!review.deleted"
              class="text-link"
              :disabled="busy"
              @click="deleteReview(review.id)"
            >
              删除评价
            </button>
          </div>
        </article>
      </div>
      <div v-else class="empty-state">
        <h2>还没有评价记录</h2>
        <p>购买并确认收货后，留下你的使用感受。</p>
      </div>
    </section>
    <CollectionPager
      :collection="
        section === 'overview'
          ? 'products'
          : section === 'addresses'
            ? 'addresses'
            : section === 'coupons'
              ? 'couponClaims'
              : section === 'reviews'
                ? 'reviews'
                : 'orders'
      "
    />
  </div>
</template>
