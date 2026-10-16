<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowUpRight, ArrowRight } from 'lucide-vue-next'
import { useShop } from '../../stores/shop'
import ProductCard from '../../components/shop/ProductCard.vue'
const shop = useShop(),
  need = ref(''),
  submitted = ref(false),
  hovered = ref('')
const products = computed(() => shop.db.products.filter((p) => p.active))
const sloganLines = computed(() => shop.db.settings.slogan.replace(/[。]$/, '').split('，'))
const picks = computed(() => {
  const q = need.value.trim().toLowerCase()
  if (!q) return products.value.filter((p) => p.featured).slice(0, 4)
  const words = q.split(/[\s，、,]+/)
  return products.value
    .filter((p) =>
      words.some((w) =>
        `${p.name}${p.subtitle}${p.description}${shop.db.categories.find((c) => c.id === p.categoryId)?.name}`
          .toLowerCase()
          .includes(w),
      ),
    )
    .slice(0, 4)
})
const preview = computed(() =>
  products.value.find((p) => p.id === hovered.value),
)
</script>
<template>
  <div class="home">
    <section class="catalogue-intro">
      <div class="home-title">
        <h1>{{ sloganLines[0] }}<template v-if="sloganLines.length > 1"><br />{{ sloganLines.slice(1).join('，') }}</template></h1>
        <p>SHOPMATE<br /><span>你的日常购物伙伴</span></p>
      </div>
      <div class="intro-top">
        <p>日常所需，认真挑选。<br />数码、家居、穿搭与更多。</p>
        <p>不确定怎么选？<br />从一个需求开始。</p>
        <RouterLink to="/products" class="button home-primary"
          >浏览全部商品 <ArrowUpRight :size="18"
        /></RouterLink>
      </div>
      <p class="catalogue-demo">{{ shop.db.settings.notice }}</p>
      <div class="sheet-heading">
        <span>一眼看完，慢慢挑选</span
        ><span>{{
          preview?.subtitle ?? `${products.length} 款演示商品 · 六种日常生活`
        }}</span>
      </div>
      <div class="contact-sheet" @mouseleave="hovered = ''">
        <RouterLink
          v-for="(p, i) in products"
          :key="p.id"
          :to="`/products/${p.id}`"
          class="sheet-frame"
          :class="{ 'sheet-dim': hovered && hovered !== p.id }"
          :style="{ '--item-delay': `${i * 65}ms` }"
          @mouseenter="hovered = p.id"
          @focus="hovered = p.id"
          ><img
            :src="p.images[0]"
            :alt="p.name"
            :loading="i < 8 ? 'eager' : 'lazy'"
          /><span>{{ p.name }}</span></RouterLink
        ><RouterLink
          to="/products?category=c6"
          class="sheet-frame sheet-category"
          style="--item-delay: 1495ms"
          ><img
            src="/images/p21.jpg"
            alt="运动户外商品目录"
            loading="lazy"
          /><span>运动户外 · 继续发现</span></RouterLink
        >
      </div>
    </section>
    <section class="home-categories">
      <div class="section-heading">
        <h2>从喜欢的生活开始</h2>
        <RouterLink to="/categories"
          >全部分类 <ArrowRight :size="18"
        /></RouterLink>
      </div>
      <div class="category-index">
        <RouterLink
          v-for="c in [...shop.db.categories].sort((a, b) => a.sort - b.sort)"
          :key="c.id"
          :to="{ path: '/products', query: { category: c.id } }"
          ><span>{{ c.name }}</span
          ><span>{{ c.description }}</span
          ><ArrowUpRight :size="25"
        /></RouterLink>
      </div>
    </section>
    <section class="shopping-partner">
      <div>
        <h2>告诉我，<br />你想找什么。</h2>
        <p>
          试试“耳机”“家居”或“运动”。根据商品名称与说明匹配，为你缩小选择范围。
        </p>
        <p class="secondary">规则推荐演示 · 未连接大模型</p>
      </div>
      <div class="partner-content">
        <form @submit.prevent="submitted = true" class="need-form">
          <label for="need">你的购物需求</label>
          <div>
            <input
              id="need"
              v-model="need"
              placeholder="比如：通勤耳机"
              @input="submitted = false"
            /><button class="button" type="submit">
              查看推荐 <ArrowUpRight :size="18" />
            </button>
          </div>
        </form>
        <div v-if="picks.length" class="mini-products">
          <ProductCard v-for="p in picks" :key="p.id" :product="p" compact />
        </div>
        <div v-else class="empty-inline">
          <p>暂时没找到匹配商品。试试更短的关键词，或让客服帮你找。</p>
          <RouterLink to="/support">咨询购物伙伴</RouterLink>
        </div>
        <p v-if="submitted && picks.length" role="status" class="secondary">
          找到 {{ picks.length }} 件匹配商品，点击查看规格与库存。
        </p>
      </div>
    </section>
    <section class="home-featured">
      <div class="section-heading">
        <h2>值得多看一眼</h2>
        <RouterLink to="/products"
          >继续逛逛 <ArrowRight :size="18"
        /></RouterLink>
      </div>
      <div class="product-grid">
        <ProductCard
          v-for="p in products.filter((p) => p.featured).slice(0, 4)"
          :key="p.id"
          :product="p"
        />
      </div>
    </section>
    <section class="service-close">
      <p>商品怎么选，订单到哪里，<br />售后怎么办。</p>
      <div>
        <h2>每个问题，都有入口。</h2>
        <p>咨询时带上商品或订单，购物伙伴会接着你的问题往下聊。</p>
        <RouterLink to="/support" class="button"
          >打开客服中心 <ArrowUpRight :size="18"
        /></RouterLink>
      </div>
    </section>
  </div>
</template>
