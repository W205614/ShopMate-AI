<script setup lang="ts">
import { onMounted, ref } from "vue";
import QRCode from "qrcode";
import { request } from "../../services/repository";
import type { Session } from "../../domain/types";
const props = defineProps<{ enrollment: boolean }>();
const emit = defineEmits<{ authenticated: [session: Session]; restart: [] }>();
const secret = ref(""),
  qr = ref(""),
  code = ref(""),
  recovery = ref(false),
  recoveryCodes = ref<string[]>([]),
  account = ref<Session>(),
  busy = ref(false),
  error = ref("");
onMounted(async () => {
  if (!props.enrollment) return;
  busy.value = true;
  try {
    const setup = await request<{ secret: string; uri: string }>(
      "/api/auth/mfa/enroll",
      {},
    );
    secret.value = setup.secret;
    qr.value = await QRCode.toDataURL(setup.uri, { width: 220, margin: 1 });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "无法准备二次验证";
  } finally {
    busy.value = false;
  }
});
async function submit() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await request<{
      account: Session;
      recoveryCodes?: string[];
    }>(
      `/api/auth/mfa/${props.enrollment ? "confirm" : recovery.value ? "recovery" : "verify"}`,
      { code: code.value.trim() },
    );
    secret.value = "";
    qr.value = "";
    code.value = "";
    account.value = result.account;
    if (result.recoveryCodes) recoveryCodes.value = result.recoveryCodes;
    else emit("authenticated", result.account);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "二次验证失败";
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section v-if="recoveryCodes.length" class="auth-form">
    <h2>保存恢复码</h2>
    <p>请保存到安全位置。每个恢复码只能使用一次，本页面离开后不再展示。</p>
    <pre>{{ recoveryCodes.join("\n") }}</pre>
    <button
      class="auth-submit"
      type="button"
      @click="
        emit('authenticated', account!);
        recoveryCodes = [];
      "
    >
      我已保存恢复码，进入后台
    </button>
  </section>
  <form v-else class="auth-form" @submit.prevent="submit">
    <h2>{{ enrollment ? "设置管理二次验证" : "管理二次验证" }}</h2>
    <p>
      {{
        enrollment
          ? "使用身份验证器扫描二维码，并输入六位验证码完成设置。"
          : recovery
            ? "请输入一个尚未使用的恢复码。"
            : "请输入身份验证器中的六位验证码。"
      }}
    </p>
    <template v-if="enrollment && secret"
      ><img :src="qr" alt="管理二次验证设置二维码" width="220" height="220" />
      <details>
        <summary>无法扫描时手动输入密钥</summary>
        <code class="mfa-secret">{{ secret }}</code>
      </details></template
    >
    <label
      >{{ recovery ? "恢复码" : "验证码"
      }}<input
        v-model="code"
        :inputmode="recovery ? 'text' : 'numeric'"
        autocomplete="one-time-code"
        required
        :maxlength="recovery ? 20 : 6"
        :pattern="recovery ? '[a-f0-9]{20}' : '[0-9]{6}'"
    /></label>
    <p class="auth-error" role="alert">{{ error }}</p>
    <button
      class="auth-submit"
      type="submit"
      :disabled="busy || (enrollment && !secret)"
    >
      {{ busy ? "验证中…" : "完成验证" }}
    </button>
    <button
      v-if="!enrollment"
      class="ghost-button"
      type="button"
      :disabled="busy"
      @click="
        recovery = !recovery;
        code = '';
        error = '';
      "
    >
      {{ recovery ? "使用身份验证器" : "使用恢复码" }}
    </button>
    <button
      class="ghost-button"
      type="button"
      :disabled="busy"
      @click="emit('restart')"
    >
      重新输入账号密码
    </button>
  </form>
</template>
<style scoped>
.mfa-secret {
  overflow-wrap: anywhere;
  user-select: all;
}
pre {
  user-select: all;
  padding: 1rem;
  background: #f5f5f2;
}
</style>
