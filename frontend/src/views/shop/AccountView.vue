<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useShop } from '../../stores/shop'
import { api } from '../../services/api'
import type { Address, AddressInput } from '../../domain/types'
import { UserRound, ArrowUpRight } from 'lucide-vue-next'
import ProductCard from '../../components/shop/ProductCard.vue'
import ActionNotice from '../../components/shop/ActionNotice.vue'
import { useAction } from '../../components/shop/useAction'
const shop = useShop(),
  route = useRoute(),
  router = useRouter(),
  section = ref(route.query.section === 'addresses' ? 'addresses' : 'overview'),
  editing = ref(false),
  form = reactive<AddressInput>({
    name: '',
    phone: '',
    region: '',
    detail: '',
    isDefault: false,
  }),
  { busy, error, notice, run } = useAction(),
  favorites = computed(() =>
    shop.db.products.filter(
      (p) => p.active && shop.db.favorites[shop.userId]?.includes(p.id),
    ),
  )
function edit(a?: Address) {
  Object.assign(form, {
    id: a?.id,
    name: a?.name ?? '',
    phone: a?.phone ?? '',
    region: a?.region ?? '',
    detail: a?.detail ?? '',
    isDefault: a?.isDefault ?? shop.myAddresses.length === 0,
  })
  editing.value = true
}
async function save() {
  if (await run(() => api.saveAddress({ ...form }), '收货地址已保存'))
    editing.value = false
}
async function remove(id: string) {
  if (window.confirm('确认删除这个收货地址？'))
    await run(() => api.deleteAddress(id), '地址已删除')
}
async function logout() {
  if (await run(() => shop.logout('user'))) await router.push('/')
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
      <RouterLink to="/orders"
        ><span>我的订单</span><strong>{{ shop.myOrders.length }}</strong
        ><ArrowUpRight /></RouterLink
      ><RouterLink to="/after-sales"
        ><span>售后服务</span
        ><strong>{{
          shop.db.afterSales.filter((a) => a.userId === shop.userId).length
        }}</strong
        ><ArrowUpRight /></RouterLink
      ><RouterLink to="/support"
        ><span>客服会话</span
        ><strong>{{
          shop.db.conversations.filter((c) => c.userId === shop.userId).length
        }}</strong
        ><ArrowUpRight
      /></RouterLink>
    </div>
    <div class="tabs">
      <button
        :class="{ selected: section === 'overview' }"
        @click="section = 'overview'"
      >
        我的收藏</button
      ><button
        :class="{ selected: section === 'addresses' }"
        @click="section = 'addresses'"
      >
        收货地址
      </button>
    </div>
    <ActionNotice :error="error" :notice="notice" />
    <section v-if="section === 'overview'">
      <div class="section-heading">
        <h2>留给下次的喜欢</h2>
        <span>{{ favorites.length }} 件收藏</span>
      </div>
      <div v-if="favorites.length" class="product-grid">
        <ProductCard v-for="p in favorites" :key="p.id" :product="p" />
      </div>
      <div v-else class="empty-state">
        <h2>收藏夹等你来填满</h2>
        <p>在商品详情点击收藏，下次来就能快速找到。</p>
        <RouterLink to="/products" class="button">浏览商品</RouterLink>
      </div>
    </section>
    <section v-else data-ui>
      <div class="section-heading">
        <h2>收货地址</h2>
        <button class="button" @click="edit()">添加地址</button>
      </div>
      <form
        v-if="editing"
        class="address-form form-stack"
        @submit.prevent="save"
      >
        <h3>{{ form.id ? '编辑地址' : '添加收货地址' }}</h3>
        <div class="form-two">
          <label
            >收货人<input
              v-model.trim="form.name"
              required
              maxlength="30"
              autocomplete="name" /></label
          ><label
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
          >省 / 市 / 区<input
            v-model.trim="form.region"
            required
            maxlength="80"
            placeholder="例如：上海市 徐汇区"
            autocomplete="address-level2" /></label
        ><label
          >详细地址<input
            v-model.trim="form.detail"
            required
            maxlength="150"
            placeholder="街道、门牌号等"
            autocomplete="street-address" /></label
        ><label class="check-label"
          ><input
            v-model="form.isDefault"
            type="checkbox"
          />设为默认收货地址</label
        >
        <div class="button-row">
          <button class="button" :disabled="busy">
            {{ busy ? '保存中…' : '保存地址' }}</button
          ><button type="button" @click="editing = false">取消</button>
        </div>
        <p class="secondary">地址保存到服务端，仅当前账号与授权管理员可访问。</p>
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
  </div>
</template>
