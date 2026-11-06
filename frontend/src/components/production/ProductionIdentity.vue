<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { request } from "../../services/repository";
import type { Session } from "../../domain/types";
const props = defineProps<{ registering: boolean }>();
const emit = defineEmits<{ authenticated: [session: Session] }>();
type Policy = { version: string; title: string; text: string };
type Config = {
  channels: ("email" | "phone")[];
  merchant: { legalName: string; privacy: Policy; terms: Policy };
};
const config = ref<Config>(),
  username = ref(""),
  name = ref(""),
  password = ref(""),
  confirmation = ref(""),
  target = ref(""),
  code = ref(""),
  channel = ref<"email" | "phone">("email"),
  challengeId = ref(""),
  verificationToken = ref(""),
  agreed = ref(false),
  recovering = ref(false),
  busy = ref(false),
  error = ref(""),
  notice = ref(""),
  nextSendAt = ref(0);
const verifying = computed(() => props.registering || recovering.value);
watch(
  () => props.registering,
  () => {
    recovering.value = false;
    error.value = "";
    challengeId.value = "";
    verificationToken.value = "";
    password.value = "";
    confirmation.value = "";
  },
);
function resetVerification() {
  challengeId.value = "";
  code.value = "";
  verificationToken.value = "";
}
watch([channel, target, recovering], resetVerification);
watch(username, () => {
  if (recovering.value) resetVerification();
});
onMounted(async () => {
  try {
    config.value = await request<Config>("/api/auth/production");
    channel.value = config.value.channels[0] ?? "email";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "无法读取注册配置";
  }
});
async function sendCode() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    if (Date.now() < nextSendAt.value)
      throw new Error("请在六十秒间隔结束后重新获取验证码");
    const result = await request<{ challengeId: string }>(
      "/api/auth/verification/send",
      {
        channel: channel.value,
        target: target.value.trim(),
        purpose: recovering.value ? "recover" : "register",
        ...(recovering.value ? { username: username.value.trim() } : {}),
      },
    );
    challengeId.value = result.challengeId;
    verificationToken.value = "";
    code.value = "";
    nextSendAt.value = Date.now() + 60_000;
    notice.value = "符合条件的联系方式将收到验证码，五分钟内有效。";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "验证码发送失败";
  } finally {
    busy.value = false;
  }
}
async function submit() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    if (verifying.value) {
      if (password.value !== confirmation.value)
        throw new Error("两次输入的密码不一致");
      if (!challengeId.value) throw new Error("请先获取验证码");
      if (props.registering && !agreed.value)
        throw new Error("请阅读并同意隐私政策和服务协议");
      if (!verificationToken.value) {
        const checked = await request<{ verificationToken: string }>(
          "/api/auth/verification/verify",
          { challengeId: challengeId.value, code: code.value },
        );
        verificationToken.value = checked.verificationToken;
      }
      if (recovering.value) {
        await request("/api/auth/recover", {
          verificationToken: verificationToken.value,
          newPassword: password.value,
        });
        recovering.value = false;
        password.value = "";
        confirmation.value = "";
        challengeId.value = "";
        notice.value = "密码已重置，旧会话已撤销。请使用新密码登录。";
        return;
      }
      const account = await request<Session>("/api/auth/register", {
        username: username.value.trim(),
        name: name.value.trim(),
        password: password.value,
        verificationToken: verificationToken.value,
        privacyVersion: config.value?.merchant.privacy.version,
        termsVersion: config.value?.merchant.terms.version,
      });
      emit("authenticated", account);
    } else
      emit(
        "authenticated",
        await request<Session>("/api/auth/login", {
          role: "user",
          username: username.value.trim(),
          password: password.value,
        }),
      );
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "操作失败，请重新核对";
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <form class="auth-form" @submit.prevent="submit">
    <h2>
      {{
        recovering ? "找回账号密码" : registering ? "创建你的账号" : "欢迎回来"
      }}
    </h2>
    <p>
      {{
        verifying ? "通过本人邮箱或手机号验证身份。" : "登录后继续购物与咨询。"
      }}
    </p>
    <label
      >账号<input
        v-model.trim="username"
        autocomplete="username"
        required
        maxlength="32"
    /></label>
    <label v-if="registering"
      >昵称<input
        v-model.trim="name"
        autocomplete="nickname"
        required
        maxlength="30"
    /></label>
    <template v-if="verifying">
      <label
        >验证方式<select
          v-model="channel"
          :disabled="busy || !config?.channels.length"
        >
          <option v-for="item in config?.channels" :key="item" :value="item">
            {{ item === "email" ? "邮箱" : "手机号" }}
          </option>
        </select></label
      >
      <label
        >{{ channel === "email" ? "邮箱" : "手机号"
        }}<input
          v-model.trim="target"
          :type="channel === 'email' ? 'email' : 'tel'"
          :autocomplete="channel === 'email' ? 'email' : 'tel'"
          required
          maxlength="254"
      /></label>
      <button
        class="ghost-button"
        type="button"
        :disabled="busy || !target || !config?.channels.length"
        @click="sendCode"
      >
        获取验证码
      </button>
      <label
        >验证码<input
          v-model="code"
          inputmode="numeric"
          autocomplete="one-time-code"
          required
          pattern="[0-9]{6}"
          maxlength="6"
      /></label>
    </template>
    <label
      >{{ recovering ? "新密码" : "密码"
      }}<input
        v-model="password"
        type="password"
        :autocomplete="verifying ? 'new-password' : 'current-password'"
        required
        :minlength="verifying ? 10 : undefined"
        maxlength="128"
    /></label>
    <label v-if="verifying"
      >确认密码<input
        v-model="confirmation"
        type="password"
        autocomplete="new-password"
        required
        maxlength="128"
    /></label>
    <template v-if="registering && config">
      <details
        v-for="policy in [config.merchant.privacy, config.merchant.terms]"
        :key="policy.title"
      >
        <summary>
          {{ policy.title }} · {{ policy.version || "尚未发布" }}
        </summary>
        <p class="policy-text">
          {{ policy.text || "商家尚未发布此协议，暂不可注册。" }}
        </p>
      </details>
      <label
        ><input
          v-model="agreed"
          type="checkbox"
          required
        />我已阅读并同意隐私政策和服务协议</label
      >
    </template>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p class="auth-error" role="alert">{{ error }}</p>
    <button
      class="auth-submit"
      type="submit"
      :disabled="
        busy ||
        !config ||
        (registering &&
          (!config.channels.length ||
            !config.merchant.privacy.version ||
            !config.merchant.terms.version))
      "
    >
      {{
        busy
          ? "处理中…"
          : recovering
            ? "重置密码"
            : registering
              ? "注册并登录"
              : "登录"
      }}
    </button>
    <button
      v-if="!registering"
      class="ghost-button"
      type="button"
      :disabled="busy"
      @click="
        recovering = !recovering;
        error = '';
        notice = '';
        challengeId = '';
      "
    >
      {{ recovering ? "返回登录" : "忘记密码" }}
    </button>
    <p class="auth-links">
      <RouterLink :to="registering ? '/login' : '/register'">{{
        registering ? "已有账号？去登录" : "还没有账号？立即注册"
      }}</RouterLink
      ><RouterLink to="/">游客浏览商城</RouterLink
      ><RouterLink to="/admin/login">管理端登录 →</RouterLink>
    </p>
  </form>
</template>
<style scoped>
.policy-text {
  white-space: pre-wrap;
  max-height: 18rem;
  overflow: auto;
}
select {
  width: 100%;
  padding: 0.6rem;
  border: 1px solid #d6d6d6;
  background: white;
}
</style>
