<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useShop } from "../stores/shop";
const route = useRoute(),
  router = useRouter(),
  shop = useShop();
const role = computed(() =>
  route.meta.loginRole === "admin" ? "admin" : "user",
);
const username = ref(""),
  password = ref(""),
  error = ref(""),
  busy = ref(false);
function fill(name: string) {
  username.value = name;
  password.value = "demo123";
}
async function login() {
  error.value = "";
  busy.value = true;
  try {
    await shop.login(role.value, username.value.trim(), password.value);
    const redirect =
      typeof route.query.redirect === "string" ? route.query.redirect : "";
    const safe =
      redirect.startsWith("/") &&
      !redirect.startsWith("//") &&
      !redirect.includes("\\") &&
      !redirect.startsWith("/login") &&
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
      <p class="demo-note">综合百货 · 本地前端演示</p>
    </section>
    <section class="auth-form-area">
      <form class="auth-form" @submit.prevent="login">
        <h2>{{ role === "admin" ? "管理端登录" : "欢迎回来" }}</h2>
        <p>
          {{
            role === "admin"
              ? "查看经营、管理商品与处理客户咨询。"
              : "登录后，继续你的购物与咨询。"
          }}
        </p>
        <label
          >账号<input
            v-model="username"
            name="username"
            autocomplete="username"
            required
            placeholder="输入演示账号" /></label
        ><label
          >密码<input
            v-model="password"
            name="password"
            autocomplete="current-password"
            type="password"
            required
            placeholder="输入演示密码"
        /></label>
        <p role="alert" class="auth-error">{{ error }}</p>
        <button class="auth-submit" type="submit" :disabled="busy">
          {{ busy ? "登录中…" : "登录" }}
        </button>
        <div class="auth-demo">
          <p>演示账号 · 密码统一为 demo123</p>
          <template v-if="role === 'user'"
            ><button type="button" @click="fill('lin')">
              填入 lin · 林小满</button
            ><button type="button" @click="fill('chen')">
              填入 chen · 陈一禾
            </button></template
          ><button v-else type="button" @click="fill('admin')">
            填入 admin · 管理员
          </button>
          <p class="demo-note">
            仅模拟会话，无真实身份认证。请勿输入真实密码。
          </p>
        </div>
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
