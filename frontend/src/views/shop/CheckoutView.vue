<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue'
import { useRouter } from 'vue-router'
import { useShop } from '../../stores/shop'
import { api } from '../../services/api'
import { money } from '../../domain/types'
import type { OrderItem } from '../../domain/types'
import OrderItems from '../../components/shop/OrderItems.vue'
import ActionNotice from '../../components/shop/ActionNotice.vue'
import { useAction } from '../../components/shop/useAction'
const shop = useShop(),
  router = useRouter(),
  addressId = ref(''),
  { busy, error, notice, run } = useAction()
watchEffect(() => {
  if (!shop.myAddresses.some((a) => a.id === addressId.value))
    addressId.value =
      shop.myAddresses.find((a) => a.isDefault)?.id ??
      shop.myAddresses[0]?.id ??
      ''
})
const items = computed<OrderItem[]>(() =>
    shop.myCart
      .filter((i) => i.selected)
      .flatMap((i) => {
        const p = shop.db.products.find((p) => p.id === i.productId),
          s = p?.skus.find((s) => s.id === i.skuId)
        return p && s
          ? [
              {
                productId: p.id,
                skuId: s.id,
                name: p.name,
                skuName: s.name,
                image: p.images[0] ?? '',
                price: s.price,
                quantity: i.quantity,
              },
            ]
          : []
      }),
  ),
  total = computed(() =>
    items.value.reduce((sum, i) => sum + i.price * i.quantity, 0),
  )
async function submit() {
  await run(async () => {
    const id = await api.createOrder(addressId.value)
    await router.push(`/orders/${id}/pay`)
  })
}
</script>
<template>
  <div class="page-wrap">
    <div class="page-heading">
      <h1>确认订单</h1>
      <p>最后确认一次，收货地址和规格都选对了吗？</p>
    </div>
    <ActionNotice :error="error" :notice="notice" />
    <div v-if="items.length" class="cart-layout" data-ui>
      <div>
        <section class="checkout-section">
          <div class="section-heading">
            <h2>寄到这里</h2>
            <RouterLink to="/account?section=addresses">管理地址</RouterLink>
          </div>
          <div v-if="shop.myAddresses.length" class="address-options">
            <label
              v-for="a in shop.myAddresses"
              :key="a.id"
              :class="{ selected: addressId === a.id }"
              ><input
                v-model="addressId"
                type="radio"
                name="address"
                :value="a.id"
              />
              <div>
                <strong>{{ a.name }} · {{ a.phone }}</strong>
                <p>{{ a.region }} {{ a.detail }}</p>
                <span v-if="a.isDefault" class="secondary">默认收货地址</span>
              </div></label
            >
          </div>
          <div v-else class="empty-inline">
            <p>请先添加一个收货地址。</p>
            <RouterLink to="/account?section=addresses" class="button"
              >添加地址</RouterLink
            >
          </div>
        </section>
        <section class="checkout-section">
          <h2>你选的好物</h2>
          <OrderItems :items="items" /><RouterLink to="/cart" class="text-link"
            >返回购物车修改</RouterLink
          >
        </section>
      </div>
      <aside class="order-summary">
        <h2>订单金额</h2>
        <div>
          <span>商品小计</span><span>{{ money(total) }}</span>
        </div>
        <div><span>配送费</span><span>¥0.00</span></div>
        <div class="summary-total">
          <span>应付金额</span><strong>{{ money(total) }}</strong>
        </div>
        <button class="button" :disabled="busy || !addressId" @click="submit">
          {{ busy ? '正在提交…' : '提交订单' }}
        </button>
        <p class="secondary">
          提交后进入模拟支付。最终库存及价格由演示服务校验。
        </p>
      </aside>
    </div>
    <div v-else class="empty-state">
      <h2>没有待结算的商品</h2>
      <p>请在购物车勾选商品后再来结算。</p>
      <RouterLink to="/cart" class="button">返回购物车</RouterLink>
    </div>
  </div>
</template>
