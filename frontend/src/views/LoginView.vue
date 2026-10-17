<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useShop } from "../stores/shop";
const route = useRoute(),
  router = useRouter(),
  shop = useShop();
const role = computed(() =>
  route.meta.loginRole === "admin" ? "admin" : "user",
);
const registering = computed(() => route.meta.register === true);
const name = ref(""),
  confirmation = ref("");
const username = ref(""),
  password = ref(""),
  error = ref(""),
  busy = ref(false);
watch(
  () => route.fullPath,
  () => {
    error.value = "";
    password.value = "";
    confirmation.value = "";
  },
);
async function login() {
  if (busy.value) return;
  error.value = "";
  if (registering.value && password.value !== confirmation.value) {
    error.value = "两次输入的密码不一致";
    return;
  }
  busy.value = true;
  try {
    if (registering.value)
      await shop.register({
        username: username.value.trim(),
        name: name.value.trim(),
        password: password.value,
      });
    else await shop.login(role.value, username.value.trim(), password.value);
    const redirect =
      typeof route.query.redirect === "string" ? route.query.redirect : "";
    const safe =
      redirect.startsWith("/") &&
      !redirect.startsWith("//") &&
      !redirect.includes("\\") &&
      !redirect.startsWith("/login") &&
      !redirect.startsWith("/register") &&
      !redirect.startsWith("/admin/login") &&
      (role.value === "admin"
        ? redirect.startsWith("/admin")
        : !redirect.startsWith("/admin"));
    await router.replace(
      safe ? redirect : role.value === "admin" ? "/admin" : "/",
    );
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "登录失败";
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <main class="auth-page">
    <section class="auth-story">
      <RouterLink to="/" class="auth-logo"
        >SHOPMATE<span aria-hidden="true">.</span></RouterLink
      >
      <div>
        <h1>
          {{
            role === "admin" ? "把生意，打理有序。" : "好物与答案，一起找到。"
          }}
        </h1>
        <div class="auth-pictures">
          <img
            src="/images/p05.jpg"
            alt="演示陶瓷杯"
            width="400"
            height="400"
          /><img
            src="/images/p01.jpg"
            alt="演示耳机"
            width="400"
            height="400"
          />
        </div>
      </div>
      <p class="demo-note">综合百货 · 你的日常好物</p>
    </section>
    <section class="auth-form-area">
      <form class="auth-form" @submit.prevent="login">
        <h2>
          {{
            role === "admin"
              ? "管理端登录"
              : registering
                ? "创建你的账号"
                : "欢迎回来"
          }}
        </h2>
        <p>
          {{
            role === "admin"
              ? "查看经营、管理商品与处理客户咨询。"
              : registering
                ? "注册后，开启你的购物与咨询。"
                : "登录后，继续你的购物与咨询。"
          }}
        </p>
        <label
          >账号<input
            v-model="username"
            name="username"
            autocomplete="username"
            required
            maxlength="32"
            placeholder="输入账号"
        /></label>
        <label v-if="registering"
          >昵称<input
            v-model.trim="name"
            name="name"
            autocomplete="nickname"
            required
            maxlength="30"
            placeholder="怎么称呼你"
        /></label>
        <label
          >密码<input
            v-model="password"
            name="password"
            :autocomplete="registering ? 'new-password' : 'current-password'"
            type="password"
            required
            maxlength="128"
            :minlength="registering ? 10 : undefined"
            :placeholder="
              registering ? '10–128 位，包含字母和数字' : '输入密码'
            "
        /></label>
        <label v-if="registering"
          >确认密码<input
            v-model="confirmation"
            name="confirmation"
            type="password"
            autocomplete="new-password"
            required
            maxlength="128"
            placeholder="再次输入密码"
        /></label>
        <p v-if="registering" class="secondary">
          账号以字母开头，支持字母、数字和下划线，3–32 位。
        </p>
        <p
          v-if="route.query.changed === '1' && role === 'user' && !registering"
          role="status"
        >
          密码已修改，请使用新密码重新登录。
        </p>
        <p role="alert" class="auth-error">{{ error }}</p>
        <button class="auth-submit" type="submit" :disabled="busy">
          {{
            busy
              ? registering
                ? "注册中…"
                : "登录中…"
              : registering
                ? "注册并登录"
                : "登录"
          }}
        </button>
        <p v-if="role === 'user'" class="auth-links">
          <RouterLink
            :to="{
              path: registering ? '/login' : '/register',
              query: route.query,
            }"
            >{{
              registering ? "已有账号？去登录" : "还没有账号？立即注册"
            }}</RouterLink
          >
        </p>
        <div class="auth-links">
          <RouterLink to="/">游客浏览商城</RouterLink
          ><RouterLink :to="role === 'admin' ? '/login' : '/admin/login'"
            >{{ role === "admin" ? "用户端登录" : "管理端登录" }} →</RouterLink
          >
        </div>
      </form>
    </section>
  </main>
</template>
