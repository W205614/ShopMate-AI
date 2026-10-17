<script setup lang="ts">
import { computed, ref } from "vue";
import {
  IMAGE_MAX_BYTES,
  IMAGES_MAX_BYTES,
  imageBytes,
} from "../../../../shared/domain/images";
import { validateDecodedImages } from "../../services/images";
const props = withDefaults(
  defineProps<{
    modelValue: string[];
    label: string;
    maximum?: number;
    disabled?: boolean;
  }>(),
  { maximum: 12, disabled: false },
);
const emit = defineEmits<{
  "update:modelValue": [value: string[]];
  busy: [value: boolean];
}>();
const sourceDraft = ref(""),
  error = ref(""),
  processing = ref(false);
const total = computed(() =>
  props.modelValue.reduce((sum, image) => {
    try {
      return sum + imageBytes(image);
    } catch {
      return sum;
    }
  }, 0),
);
async function append(images: () => Promise<string[]>) {
  if (processing.value || props.disabled) return;
  processing.value = true;
  emit("busy", true);
  error.value = "";
  try {
    const next = [...props.modelValue, ...(await images())];
    await validateDecodedImages(next, props.maximum);
    emit("update:modelValue", next);
    sourceDraft.value = "";
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "读取图片失败，请重新选择";
  } finally {
    processing.value = false;
    emit("busy", false);
  }
}
function addSource() {
  return append(async () => [sourceDraft.value.trim()]);
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  if (!files.length) return;
  try {
    await append(async () => {
      if (props.modelValue.length + files.length > props.maximum)
        throw new Error(`最多支持 ${props.maximum} 张图片`);
      for (const file of files) {
        if (
          !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
          file.size > IMAGE_MAX_BYTES
        )
          throw new Error(`${file.name}：请上传 2 MiB 内的 PNG/JPEG/WebP 图片`);
      }
      const existingBytes = props.modelValue.reduce(
        (sum, source) => sum + imageBytes(source),
        0,
      );
      if (
        existingBytes + files.reduce((sum, file) => sum + file.size, 0) >
        IMAGES_MAX_BYTES
      )
        throw new Error("商品图片合计不能超过 5 MiB");
      return Promise.all(
        files.map((file) => {
          return new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = reader.onabort = () =>
              reject(new Error(`${file.name}：读取图片失败，请重新选择`));
            reader.readAsDataURL(file);
          });
        }),
      );
    });
  } finally {
    input.value = "";
  }
}
function remove(index: number) {
  emit(
    "update:modelValue",
    props.modelValue.filter((_, i) => i !== index),
  );
  error.value = "";
}
</script>
<template>
  <div class="image-editor">
    <p class="admin-note">
      PNG/JPEG/WebP，每张最多 2 MiB，合计最多 5 MiB；{{ modelValue.length }} /
      {{ maximum }} 张，{{ (total / 1024 / 1024).toFixed(2) }} MiB。
    </p>
    <div class="image-source-row">
      <el-input
        v-model="sourceDraft"
        :aria-label="`${label}内置路径`"
        placeholder="/images/p01.jpg"
        :disabled="disabled || processing"
        @keydown.enter.prevent="addSource"
      /><el-button
        :disabled="disabled || processing || !sourceDraft.trim()"
        @click="addSource"
        >添加内置图片</el-button
      >
    </div>
    <input
      type="file"
      accept="image/png,image/jpeg,image/webp"
      :multiple="maximum > 1"
      :aria-label="`上传${label}`"
      :disabled="disabled || processing"
      @change="upload"
    />
    <p v-if="processing" role="status">正在读取并检查图片…</p>
    <p v-if="error" class="image-editor-error" role="alert">{{ error }}</p>
    <div class="image-editor-previews">
      <div v-for="(src, index) in modelValue" :key="index">
        <img
          :src="src"
          :alt="`${label}预览`"
          class="admin-image-preview"
        /><el-button
          :aria-label="`移除${label} ${index + 1}`"
          :disabled="disabled || processing"
          link
          type="danger"
          @click="remove(index)"
          >移除</el-button
        >
      </div>
    </div>
  </div>
</template>
<style scoped>
.image-editor {
  width: 100%;
}
.image-source-row {
  display: flex;
  gap: 8px;
  margin: 10px 0;
}
.image-editor-previews {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.image-editor-previews > div {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.image-editor-error {
  color: var(--el-color-danger);
}
input[type="file"] {
  max-width: 100%;
}
@media (max-width: 600px) {
  .image-source-row {
    flex-direction: column;
  }
}
</style>
