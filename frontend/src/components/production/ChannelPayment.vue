<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import QRCode from "qrcode";
import type {
  Payment,
  PaymentChannel,
} from "../../../../shared/domain/production";
import { productionApi } from "../../services/production";
import { request, refreshState } from "../../services/repository";
const props = defineProps<{ orderId: string; expired: boolean }>();
const channels = ref<PaymentChannel[]>([]),
  channel = ref<PaymentChannel>(),
  current = ref<Payment | null>(null),
  busy = ref(false),
  error = ref(""),
  qr = ref("");
const labels: Record<PaymentChannel, string> = {
  wechat_native: "微信扫码支付",
  wechat_h5: "微信支付",
  alipay_page: "支付宝支付",
  alipay_wap: "支付宝支付",
};
const statuses = {
  creating: "正在创建支付单",
  pending: "等待渠道确认付款",
  unknown: "支付结果待核对，请勿重复付款",
  succeeded: "付款成功",
  closed: "支付单已关闭",
  failed: "支付未受理，可重新选择渠道",
};
const active = computed(
  () =>
    !!current.value &&
    ["creating", "pending", "unknown"].includes(current.value.status),
);
const wechatBrowser = /MicroMessenger/i.test(navigator.userAgent);
let alive = true,
  timer: number | undefined;
watch(
  () => current.value?.checkout,
  async (value) => {
    qr.value =
      value?.kind === "qr"
        ? await QRCode.toDataURL(value.value, { width: 240, margin: 2 })
        : "";
  },
);
async function load() {
  const result = await request<{ payments: Payment[] }>(
    `/api/orders/${encodeURIComponent(props.orderId)}/payments`,
  );
  if (alive)
    current.value =
      result.payments.find(
        (payment) => !["closed", "failed"].includes(payment.status),
      ) ??
      result.payments[0] ??
      null;
  if (current.value && ["closed", "failed"].includes(current.value.status))
    sessionStorage.removeItem(
      `shopmate:payment:${props.orderId}:${current.value.channel}`,
    );
  if (current.value?.status === "succeeded") await refreshState("user");
}
async function act(operation: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await operation();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "支付服务暂不可用";
  } finally {
    busy.value = false;
  }
}
function create() {
  return act(async () => {
    if (!channel.value)
      throw new Error(
        "当前设备没有已启用的支付入口，请使用电脑浏览器或联系商家",
      );
    if (wechatBrowser && channel.value === "wechat_h5")
      throw new Error("请在手机外部浏览器打开商城后使用微信支付");
    const key = `shopmate:payment:${props.orderId}:${channel.value}`;
    const requestId = sessionStorage.getItem(key) ?? crypto.randomUUID();
    sessionStorage.setItem(key, requestId);
    current.value = await request<Payment>("/api/payments", {
      orderId: props.orderId,
      channel: channel.value,
      requestId,
    });
    if (["failed", "closed"].includes(current.value.status))
      sessionStorage.removeItem(key);
  });
}
function refresh() {
  return act(async () => {
    if (current.value)
      current.value = await request<Payment>(
        `/api/payments/${current.value.id}/refresh`,
        { requestId: crypto.randomUUID() },
      );
    await load();
  });
}
function close() {
  return act(async () => {
    if (!current.value) return;
    const previous = current.value;
    current.value = await request<Payment>(
      `/api/payments/${previous.id}/close`,
      { requestId: crypto.randomUUID() },
    );
    if (["closed", "failed"].includes(current.value.status))
      sessionStorage.removeItem(
        `shopmate:payment:${props.orderId}:${previous.channel}`,
      );
    await refreshState("user");
  });
}
function openCheckout() {
  return act(async () => {
    if (!current.value) return;
    const latest = await request<Payment>(
      `/api/payments/${current.value.id}/refresh`,
      { requestId: crypto.randomUUID() },
    );
    if (!alive) return;
    current.value = latest;
    if (latest.status === "succeeded") {
      await refreshState("user");
      return;
    }
    if (props.expired) throw new Error("订单已超时，请核对关闭结果");
    if (latest.status !== "pending" || latest.closeRequested)
      throw new Error("支付状态已变化，请核对渠道结果后继续");
    if (wechatBrowser && latest.channel === "wechat_h5")
      throw new Error("请在手机外部浏览器打开商城后使用微信支付");
    const checkout = latest.checkout;
    if (
      checkout?.kind !== "redirect" ||
      (latest.channel === "wechat_h5" && !checkout.expiresAt) ||
      (checkout.expiresAt && Date.parse(checkout.expiresAt) <= Date.now())
    )
      throw new Error("支付链接尚未就绪或已过期，请查询后重试");
    if (alive) window.location.assign(checkout.value);
  });
}
onMounted(() => {
  void act(async () => {
    const config = await productionApi.capabilities();
    const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    channels.value = config.paymentChannels.filter((value) =>
      mobile
        ? ["wechat_h5", "alipay_wap"].includes(value)
        : ["wechat_native", "alipay_page"].includes(value),
    );
    channel.value = channels.value[0];
    await load();
    timer = window.setInterval(() => {
      if (!document.hidden && !busy.value && active.value) void act(load);
    }, 3000);
  });
});
onUnmounted(() => {
  alive = false;
  if (timer) window.clearInterval(timer);
});
</script>
<template>
  <section aria-label="渠道支付">
    <p v-if="wechatBrowser" class="secondary">
      微信 H5 支付需要在手机外部浏览器打开商城。
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="current">
      <p role="status">
        {{ statuses[current.status]
        }}<span v-if="current.closeRequested && active">，正在确认关单</span>
      </p>
      <p class="secondary">支付单号 {{ current.id }}</p>
      <img
        v-if="qr && active && !current.closeRequested"
        :src="qr"
        alt="微信支付二维码"
        width="240"
        height="240"
      />
      <button
        v-if="
          active &&
          !current.closeRequested &&
          current.checkout?.kind === 'redirect'
        "
        class="button"
        :disabled="busy"
        @click="openCheckout"
      >
        前往支付平台
      </button>
      <div v-if="active" class="payment-actions">
        <button
          class="button button-secondary"
          :disabled="busy"
          @click="refresh"
        >
          查询付款结果
        </button>
        <button
          class="text-link"
          :disabled="busy || current.closeRequested"
          @click="close"
        >
          关闭支付单以切换渠道
        </button>
      </div>
      <p v-if="current.errorCode" class="secondary">
        状态代码 {{ current.errorCode }}，可查询结果或联系商家核对。
      </p>
    </template>
    <div
      v-if="!active && current?.status !== 'succeeded' && !expired"
      class="payment-actions"
    >
      <label
        >支付方式
        <select v-model="channel" :disabled="busy">
          <option v-for="value in channels" :key="value" :value="value">
            {{ labels[value] }}
          </option>
        </select></label
      >
      <button class="button" :disabled="busy || !channel" @click="create">
        {{ busy ? "处理中…" : "创建支付单" }}
      </button>
    </div>
    <p class="secondary">
      商城不会收集支付密码。页面跳转不代表付款成功，请核对商城确认的渠道结果。
    </p>
  </section>
</template>
