<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { AssetCredit } from "../domain/asset-manifest";

const assetCredits = ref<AssetCredit[]>([]);
const loadFailed = ref(false);
onMounted(async () => {
  try {
    const response = await window.fetch("/images/credits.json");
    if (!response.ok) throw new Error("图片来源清单加载失败");
    assetCredits.value = await response.json();
  } catch {
    loadFailed.value = true;
  }
});
</script>
<template>
  <main class="credits-page">
    <h1>素材与演示说明</h1>
    <p>
      ShopMate-AI
      是单店电商演示。商品名称、规格、价格、库存、订单与经营数据均为虚构示例；图片仅为品类演示，不代表真实在售商品、品牌授权，或图片作者与本站存在商业关系。部分照片带有原始品牌标识。
    </p>
    <p>
      登录与注册由服务端验证，账号和业务数据保存在服务端数据库。支付和物流使用模拟流程，AI
      客服由部署方按需启用。
    </p>
    <h2>图片来源</h2>
    <p v-if="loadFailed" role="alert">
      图片来源清单加载失败。<a href="/images/credits.json">查看署名清单</a>
    </p>
    <div v-else class="credits-list">
      <article
        v-for="credit in assetCredits"
        :key="credit.id"
        class="credit-item"
      >
        <img
          :src="credit.file"
          :alt="credit.title"
          loading="lazy"
          width="400"
          height="240"
        />
        <p>{{ credit.title }} · {{ credit.creator }}</p>
        <p>
          <a
            :href="credit.licenseUrl"
            target="_blank"
            rel="noopener noreferrer"
            >{{ credit.license }}</a
          >
          · 原图经缩放与 JPEG 转码，页面可能裁切展示。
        </p>
        <a :href="credit.source" target="_blank" rel="noopener noreferrer"
          >查看原始来源 ↗</a
        >
      </article>
    </div>
    <p>
      本地品牌标题字体：Libre Franklin，按 SIL Open Font License
      分发；正文与中文使用设备系统无衬线字体。<a
        href="/licenses/libre-franklin.txt"
        >Libre Franklin 许可</a
      >
    </p>
  </main>
</template>
