import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  api,
  getDatabase,
  getMemberSummary,
  getSession,
  getStorageIssue,
  subscribeDatabase,
  getSyncStatus,
} from "../services/api";
import type { Role } from "../domain/types";

export const useShop = defineStore("shop", () => {
  const db = ref(getDatabase());
  const summary = ref(getMemberSummary());
  const storageIssue = ref(getStorageIssue());
  const syncStatus = ref(getSyncStatus());
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
    summary.value = getMemberSummary();
    storageIssue.value = getStorageIssue();
    syncStatus.value = getSyncStatus();
    userSession.value = getSession("user");
    adminSession.value = getSession("admin");
  });
  async function login(role: Role, username: string, password: string) {
    await api.login(role, username, password);
  }
  async function logout(role: Role) {
    await api.logout(role);
  }
  async function register(input: {
    username: string;
    name: string;
    password: string;
  }) {
    await api.register(input);
  }
  return {
    db,
    summary,
    storageIssue,
    syncStatus,
    user,
    userId,
    admin,
    userSession,
    adminSession,
    myCart,
    myOrders,
    myAddresses,
    login,
    register,
    logout,
  };
});
