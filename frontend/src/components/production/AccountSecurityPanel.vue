<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { confirmSession, request } from "../../services/repository";
import { useShop } from "../../stores/shop";
const emit = defineEmits<{ closed: [] }>();
const shop = useShop(),
  actorId = shop.userSession?.id;
let alive = true;
const currentActor = () => alive && shop.userSession?.id === actorId;
onBeforeUnmount(() => {
  alive = false;
});
type Contact = { channel: "email" | "phone"; masked: string };
type SessionItem = { id: string; expiresAt: number; current: boolean };
type Policy = { version: string; title: string; text: string };
const policies = ref<{ privacy: Policy; terms: Policy }>(),
  agreed = ref(false);
const contacts = ref<Contact[]>([]),
  channels = ref<("email" | "phone")[]>([]),
  sessions = ref<SessionItem[]>([]),
  production = ref(false),
  channel = ref<"email" | "phone">("email"),
  target = ref(""),
  code = ref(""),
  password = ref(""),
  challengeId = ref(""),
  verificationToken = ref(""),
  confirmation = ref(""),
  busy = ref(false),
  error = ref(""),
  notice = ref("");
watch([channel, target], () => {
  challengeId.value = "";
  code.value = "";
  verificationToken.value = "";
});
async function load() {
  const config = await request<{
    production: boolean;
    merchant: { privacy: Policy; terms: Policy };
  }>("/api/auth/production");
  if (!currentActor()) return;
  production.value = config.production;
  policies.value = config.merchant;
  const [contactResult, sessionResult] = await Promise.all([
    request<{ contacts: Contact[]; channels: ("email" | "phone")[] }>(
      "/api/auth/contacts",
    ),
    request<{ items: SessionItem[] }>("/api/auth/sessions"),
  ]);
  if (!currentActor()) return;
  contacts.value = contactResult.contacts;
  channels.value = contactResult.channels;
  channel.value = channels.value[0] ?? "email";
  sessions.value = sessionResult.items;
}
onMounted(() => run(load));
async function run(action: () => Promise<void>) {
  if (busy.value || !currentActor()) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await action();
  } catch (cause) {
    if (currentActor())
      error.value = cause instanceof Error ? cause.message : "操作失败";
  } finally {
    if (currentActor()) busy.value = false;
  }
}
function send() {
  return run(async () => {
    const result = await request<{ challengeId: string }>(
      "/api/auth/verification/send",
      { channel: channel.value, target: target.value.trim(), purpose: "bind" },
    );
    if (!currentActor()) return;
    challengeId.value = result.challengeId;
    verificationToken.value = "";
    code.value = "";
    notice.value = "验证码已提交发送，五分钟内有效；六十秒后可重新获取。";
  });
}
function bind() {
  return run(async () => {
    if (!challengeId.value) throw new Error("请先获取验证码");
    if (!verificationToken.value) {
      const checked = await request<{ verificationToken: string }>(
        "/api/auth/verification/verify",
        { challengeId: challengeId.value, code: code.value },
      );
      if (!currentActor()) return;
      verificationToken.value = checked.verificationToken;
    }
    await request("/api/auth/contacts", {
      verificationToken: verificationToken.value,
      password: password.value,
    });
    if (!currentActor()) return;
    challengeId.value = "";
    verificationToken.value = "";
    code.value = "";
    target.value = "";
    password.value = "";
    await load();
    notice.value = "联系方式已验证并保存。";
  });
}
function revoke(item: SessionItem) {
  return run(async () => {
    await request("/api/auth/sessions/revoke", { id: item.id, role: "user" });
    if (!currentActor()) return;
    if (item.current) {
      confirmSession("user", null);
      emit("closed");
    } else {
      await load();
      notice.value = "会话已撤销。";
    }
  });
}
function acceptPolicies() {
  return run(async () => {
    if (!agreed.value || !policies.value)
      throw new Error("请阅读并同意当前协议");
    await request("/api/auth/consents", {
      privacyVersion: policies.value.privacy.version,
      termsVersion: policies.value.terms.version,
    });
    if (!currentActor()) return;
    agreed.value = false;
    notice.value = "当前协议已确认。";
  });
}
function exportData() {
  return run(async () => {
    const result = await request("/api/auth/export", {
      password: password.value,
    });
    if (!currentActor()) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "shopmate-personal-data.json";
    link.click();
    URL.revokeObjectURL(url);
    password.value = "";
    notice.value = "个人资料已导出，请妥善保管。";
  });
}
function closeAccount() {
  return run(async () => {
    await request("/api/auth/close", {
      password: password.value,
      confirmation: confirmation.value,
      requestId: crypto.randomUUID(),
    });
    if (!currentActor()) return;
    confirmSession("user", null);
    password.value = "";
    emit("closed");
  });
}
</script>
<template>
  <section class="account-production-security">
    <h3>已验证的联系方式</h3>
    <ul v-if="contacts.length">
      <li v-for="contact in contacts" :key="contact.channel">
        {{ contact.channel === "email" ? "邮箱" : "手机号" }}：{{
          contact.masked
        }}
      </li>
    </ul>
    <p v-else>尚未验证联系方式。生产商城下单前需完成验证。</p>
    <form v-if="production" @submit.prevent="bind">
      <label
        >验证方式<select v-model="channel">
          <option v-for="option in channels" :key="option" :value="option">
            {{ option === "email" ? "邮箱" : "手机号" }}
          </option>
        </select></label
      >
      <label
        >新联系方式<input
          v-model.trim="target"
          :type="channel === 'email' ? 'email' : 'tel'"
          required
          maxlength="254"
      /></label>
      <button
        type="button"
        class="ghost-button"
        :disabled="busy || !target"
        @click="send"
      >
        获取验证码
      </button>
      <label
        >验证码<input
          v-model="code"
          inputmode="numeric"
          autocomplete="one-time-code"
          pattern="[0-9]{6}"
          maxlength="6"
          required
      /></label>
      <label
        >当前密码<input
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
          maxlength="128" /></label
      ><button class="primary-button" :disabled="busy">验证并绑定／更换</button>
    </form>
    <form v-if="production && policies" @submit.prevent="acceptPolicies">
      <h3>当前交易协议</h3>
      <details
        v-for="policy in [policies.privacy, policies.terms]"
        :key="policy.title"
      >
        <summary>
          {{ policy.title }} · {{ policy.version || "尚未发布" }}
        </summary>
        <p class="policy-text">{{ policy.text }}</p>
      </details>
      <label
        ><input
          v-model="agreed"
          type="checkbox"
          required
        />我已阅读并同意当前隐私政策和服务协议</label
      >
      <button
        class="ghost-button"
        :disabled="
          busy ||
          !agreed ||
          !policies.privacy.version ||
          !policies.terms.version
        "
      >
        确认协议
      </button>
    </form>
    <h3>登录会话</h3>
    <ul>
      <li v-for="item in sessions" :key="item.id">
        {{ item.current ? "当前会话" : "其他会话" }} ·
        {{
          new Date(item.expiresAt).toLocaleString("zh-CN", {
            timeZone: "Asia/Shanghai",
          })
        }}
        到期
        <button
          type="button"
          class="ghost-button"
          :disabled="busy"
          @click="revoke(item)"
        >
          撤销{{ item.current ? "并退出" : "" }}
        </button>
      </li>
    </ul>
    <h3>资料与账号</h3>
    <p>
      导出仅包含本人的资料。注销前须完成订单、售后和资金核对；必要交易记录保留脱敏关联。
    </p>
    <label
      >当前密码<input
        v-model="password"
        type="password"
        autocomplete="current-password"
        maxlength="128" /></label
    ><button
      type="button"
      class="ghost-button"
      :disabled="busy || !password"
      @click="exportData"
    >
      导出本人资料
    </button>
    <details>
      <summary>注销账号</summary>
      <label
        >请输入“注销账号”确认<input
          v-model="confirmation"
          autocomplete="off"
          maxlength="4" /></label
      ><button
        type="button"
        class="ghost-button"
        :disabled="busy || !password || confirmation !== '注销账号'"
        @click="closeAccount"
      >
        确认注销
      </button>
    </details>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.account-production-security {
  display: grid;
  gap: 0.8rem;
  padding-block: 1.5rem;
  border-top: 1px solid #deded8;
}
form {
  display: grid;
  gap: 0.75rem;
  max-width: 30rem;
}
label {
  display: grid;
  gap: 0.35rem;
}
input,
select {
  padding: 0.6rem;
  border: 1px solid #d6d6d6;
  background: white;
}
li {
  margin-block: 0.4rem;
}
.policy-text {
  white-space: pre-wrap;
  max-height: 18rem;
  overflow: auto;
}
</style>
