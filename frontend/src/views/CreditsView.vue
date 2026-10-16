<script setup lang="ts">
import { assetCredits, assetLicenseLinks } from "../domain/asset-manifest";
</script>
<template>
  <main class="credits-page">
    <h1>素材与演示说明</h1>
    <p>
      ShopMate-AI
      是前端交互演示。商品名称、规格、价格、库存、订单与经营数据均为虚构示例；图片仅为品类演示，不代表真实在售商品、品牌授权，或图片作者与本站存在商业关系。部分照片带有原始品牌标识。
    </p>
    <p>
      支付、物流和客服均为本地模拟，无真实交易或模型服务。演示数据保存在当前浏览器，同源标签页可同步，不跨设备共享。
    </p>
    <h2>图片来源</h2>
    <div class="credits-list">
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
            :href="assetLicenseLinks[credit.id]"
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
      本地字体：Libre Franklin、Source Serif 4，均按 SIL Open Font License
      分发；中文使用设备系统字体。<a href="/licenses/libre-franklin.txt">Libre Franklin 许可</a> · <a href="/licenses/source-serif-4.txt">Source Serif 4 许可</a>
    </p>
  </main>
</template>
