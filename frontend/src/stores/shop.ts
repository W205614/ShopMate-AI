import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  api,
  getDatabase,
  getSession,
  getStorageIssue,
  subscribeDatabase,
} from "../services/api";
import type { Role } from "../domain/types";

export const useShop = defineStore("shop", () => {
  const db = ref(getDatabase());
  const storageIssue = ref(getStorageIssue());
  const userSession = ref(getSession("user"));
  const adminSession = ref(getSession("admin"));
  const user = computed(
    () => db.value.users.find((u) => u.id === userSession.value?.id) ?? null,
  );
  const userId = computed(() => user.value?.id ?? "");
  const admin = computed(() => !!adminSession.value);
  const myCart = computed(() =>
    db.value.carts.filter((i) => i.userId === userId.value),
  );
  const myOrders = computed(() =>
    db.value.orders.filter((o) => o.userId === userId.value),
  );
  const myAddresses = computed(() =>
    db.value.addresses.filter((a) => a.userId === userId.value),
  );
  subscribeDatabase((value) => {
    db.value = value;
    storageIssue.value = getStorageIssue();
  });
  async function login(role: Role, username: string, password: string) {
    const session = await api.login(role, username, password);
    if (role === "user") userSession.value = session;
    else adminSession.value = session;
  }
  async function logout(role: Role) {
    await api.logout(role);
    if (role === "user") userSession.value = null;
    else adminSession.value = null;
  }
  return {
    db,
    storageIssue,
    user,
    userId,
    admin,
    userSession,
    adminSession,
    myCart,
    myOrders,
    myAddresses,
    login,
    logout,
  };
});
